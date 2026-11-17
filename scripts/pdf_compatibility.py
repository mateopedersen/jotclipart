"""Source-preserving repair of confirmed native-reader JPX failures.

No resize, crop, mask quantization, original overwrite or publication occurs here.
The caller must retain the original and publish a separately reviewed immutable
derivative with the returned actual colorspace and byte/hash facts.
"""
import hashlib, io, json, struct, zlib
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
from PIL import Image, ImageCms
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject

def sha(data):
    return hashlib.sha256(data).hexdigest()

def decode_jpx(image):
    data=image._data
    color=image['/ColorSpace']
    count=4 if color=='/DeviceCMYK' else 3 if color=='/DeviceRGB' else 1 if color=='/DeviceGray' else int(color[1].get_object()['/N']) if isinstance(color,list) and color[0]=='/ICCBased' else None
    if count is None:raise ValueError('Unsupported explicit source colorspace')
    if count==4 and data[:4]==bytes.fromhex('ff4fff51'):
        # A raw four-component codestream is otherwise exposed as RGBA by
        # OpenJPEG/Pillow, incorrectly treating its K color plane as alpha.
        box=lambda kind,body:struct.pack('>I',len(body)+8)+kind+body
        header=box(b'ihdr',struct.pack('>IIHBBBB',int(image['/Height']),int(image['/Width']),4,7,7,0,0))+box(b'colr',b'\x01\x00\x00'+struct.pack('>I',12))
        data=box(b'jP  ',b'\r\n\x87\n')+box(b'ftyp',b'jpx '+struct.pack('>I',0)+b'jpx ')+box(b'jp2h',header)+box(b'jp2c',data)
    pixels=Image.open(io.BytesIO(data));pixels.load()
    expected={1:'L',3:'RGB',4:'CMYK'}[count]
    if pixels.mode!=expected or pixels.size!=(int(image['/Width']),int(image['/Height'])):
        raise ValueError('Decoded sample layout differs from explicit PDF color planes')
    return pixels

def repair_confirmed_jpx(source, output, maximum_bytes=1_000_000, max_sample_rmse=1.8):
    source=Path(source);output=Path(output)
    if output.exists():raise ValueError('New immutable derivative path required')
    original=source.read_bytes();reader=PdfReader(io.BytesIO(original))
    if len(reader.pages)!=1:raise ValueError('Single-page artwork repair only; hold multipage files')
    images=reader.pages[0]['/Resources'].get('/XObject',{})
    targets=[(name,x.get_object()) for name,x in images.items() if x.get_object().get('/Filter')=='/JPXDecode']
    if len(targets)!=1:raise ValueError('Exactly one faulty direct JPX artwork required')
    name,image=targets[0];pixels=decode_jpx(image)
    mask=image.get('/SMask');mask_bytes=mask.get_object().get_data() if mask else None
    # pypdf fully decodes the declared predictor; require the exact source plane
    # layout, and leave its original compressed mask object completely untouched.
    if mask:
        mask_object=mask.get_object()
        if (int(mask_object['/Width']),int(mask_object['/Height']),int(mask_object['/BitsPerComponent']),mask_object['/ColorSpace'])!=(pixels.width,pixels.height,8,'/DeviceGray') or len(mask_bytes)!=pixels.width*pixels.height:
            raise ValueError('Unsupported source alpha layout')
    weights=np.frombuffer(mask_bytes,np.uint8).reshape((pixels.height,pixels.width))/255 if mask else np.ones((pixels.height,pixels.width))
    if not weights.sum():raise ValueError('Empty source alpha; not a codec-only repair')
    candidates=[]
    def encode(mode,pix,profile=None):
        array=np.asarray(pix).astype(float)
        if array.ndim==2:array=array[:,:,None]
        # Native Apple readers reject the four-component CMYK JPX fixture.
        # A fully boxed three-component RGB JP2 is separately permitted only
        # after the source ICC conversion; never reuse a CMYK codestream as RGB.
        encodings=[('flate',None)]+[('jpeg',q) for q in [100,99,98,97,96,95]]
        if mode=='RGB':encodings += [('rgb-jp2',q) for q in range(60,43,-2)]
        for codec,quality in encodings:
            if quality is None:
                data=zlib.compress(pix.tobytes(),9);filter_name='/FlateDecode';error=0.0
            elif codec=='jpeg':
                stream=io.BytesIO();pix.save(stream,format='JPEG',quality=quality,subsampling=0,optimize=True);data=stream.getvalue();filter_name='/DCTDecode'
                decoded=np.asarray(Image.open(io.BytesIO(data))).astype(float)
                if decoded.ndim==2:decoded=decoded[:,:,None]
                error=float(np.sqrt((((array-decoded)**2)*weights[:,:,None]).sum()/(weights.sum()*array.shape[2])))
            else:
                stream=io.BytesIO();pix.save(stream,format='JPEG2000',irreversible=True,quality_mode='dB',quality_layers=[quality],no_jp2=False,mct=1)
                data=stream.getvalue();filter_name='/JPXDecode'
                if data[:12]!=bytes.fromhex('0000000c6a5020200d0a870a'):raise ValueError('Full standard JP2 signature required')
                decodedImage=Image.open(io.BytesIO(data));decodedImage.load()
                if decodedImage.mode!='RGB' or decodedImage.size!=pix.size:raise ValueError('RGB JP2 component layout differs')
                decoded=np.asarray(decodedImage).astype(float)
                error=float(np.sqrt((((array-decoded)**2)*weights[:,:,None]).sum()/(weights.sum()*3)))
            if error>max_sample_rmse:continue
            writer=PdfWriter();writer.clone_document_from_reader(PdfReader(io.BytesIO(original)))
            target=writer.pages[0]['/Resources']['/XObject'][name].get_object();target._data=data;target[NameObject('/Filter')]=NameObject(filter_name)
            target.pop(NameObject('/DecodeParms'),None)
            if mode=='CMYK' and quality is not None:target[NameObject('/Decode')]=ArrayObject([NumberObject(v) for v in [1,0]*4])
            else:target.pop(NameObject('/Decode'),None)
            if profile:
                icc=DecodedStreamObject();icc.set_data(profile);icc[NameObject('/N')]=NumberObject(3);icc[NameObject('/Alternate')]=NameObject('/DeviceRGB')
                color=ArrayObject([NameObject('/ICCBased'),writer._add_object(icc.flate_encode())]);target[NameObject('/ColorSpace')]=color
                if writer.pages[0].get('/Group'):writer.pages[0]['/Group'].get_object()[NameObject('/CS')]=color
            writer.add_metadata({'/Producer':'JotClipart verified PDF compatibility repair (pypdf)','/ModDate':datetime.now(timezone.utc).strftime('D:%Y%m%d%H%M%SZ')})
            writer.compress_identical_objects(remove_duplicates=True,remove_unreferenced=True)
            buffer=io.BytesIO();writer.write(buffer);body=buffer.getvalue()
            candidates.append({'mode':mode,'codec':codec,'quality':quality,'filter':filter_name,'bytes':len(body),'sampleRMSE':error})
            if len(body)<=maximum_bytes:return body,{'mode':mode,'codec':codec,'quality':quality,'filter':filter_name,'sampleRMSE':error}
        return None
    result=encode(pixels.mode,pixels)
    if not result and pixels.mode=='CMYK':
        color=image['/ColorSpace']
        if not isinstance(color,list) or color[0]!='/ICCBased':raise ValueError('No source ICC; hold rather than guess conversion')
        profile=ImageCms.ImageCmsProfile(io.BytesIO(color[1].get_object().get_data()));srgb=ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB'))
        rgb=ImageCms.profileToProfile(pixels,profile,srgb,outputMode='RGB',renderingIntent=1)
        result=encode('RGB',rgb,srgb.tobytes())
    if not result:raise ValueError('No compatible full-resolution encoding meets byte/quality bounds: '+json.dumps(candidates))
    body,details=result
    repaired=PdfReader(io.BytesIO(body));after=repaired.pages[0]['/Resources']['/XObject'][name].get_object()
    if list(repaired.pages[0].mediabox)!=list(reader.pages[0].mediabox):raise ValueError('Page geometry changed')
    if mask_bytes!=(after['/SMask'].get_object().get_data() if after.get('/SMask') else None):raise ValueError('Original alpha changed')
    if source.read_bytes()!=original:raise ValueError('Original changed')
    output.write_bytes(body)
    color=after['/ColorSpace'];color_label=('ICC-based '+details['mode']) if isinstance(color,list) and color[0]=='/ICCBased' else str(color).removeprefix('/')
    return {'sourceSHA256':sha(original),'sha256':sha(body),'bytes':len(body),'width':pixels.width,'height':pixels.height,'sourceMode':pixels.mode,'pdfColorSpace':color_label,'originalAlphaSHA256':sha(mask_bytes) if mask_bytes else None,'originalAlphaPreserved':True,'fullResolutionPreserved':True,'originalRetained':True,'candidateMeasurements':candidates,**details}
