"""Read-only macOS artwork-PDF check; no publication or original modification.

Usage: bundled-python scripts/check_pdf_native.py INPUT.pdf NEW_WORK_OUTPUT [ORIGINAL.webp]
Requires the normal PDF runtime (Pillow, pypdfium2, numpy) and macOS Swift.
"""
import hashlib,json,subprocess,sys,platform
from pathlib import Path
import pypdfium2 as pdfium
from PIL import Image,ImageStat
from verify_pdf_pixel_pair import verify_pair

if platform.system()!='Darwin':raise SystemExit('A real macOS reader is required; do not report a native check on another platform')
source=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve();root=Path.cwd().resolve()
if not out.is_relative_to(root/'work') or out.exists():raise SystemExit('New protected work output required')
body=source.read_bytes();digest=hashlib.sha256(body).hexdigest();out.mkdir(parents=True,mode=0o700)
swift=Path(__file__).with_name('pdf-native-render.swift').resolve();codeSHA=hashlib.sha256(swift.read_bytes()).hexdigest()
cache=root/'work/pdf-native-check-cache'/codeSHA;cache.mkdir(parents=True,exist_ok=True);binary=cache/'render'
if not binary.exists():subprocess.run(['swiftc','-O',str(swift),'-o',str(binary)],check=True,capture_output=True)
doc=pdfium.PdfDocument(body)
if len(doc)!=1:raise SystemExit('Artwork check requires one page; inspect all pages of this container separately')
page=doc[0];bitmap=page.render(scale=384/max(page.get_size()));reference=bitmap.to_pil().copy();bitmap.close();page.close();doc.close()
reference.save(out/'reference.png');png=out/'mac-native.png'
subprocess.run([str(binary),'pdf',str(source),str(png)],check=True,capture_output=True)
nativeStd=ImageStat.Stat(Image.open(png).convert('RGB')).stddev;referenceStd=ImageStat.Stat(reference.convert('RGB')).stddev
passed=max(nativeStd)>.2 and max(referenceStd)>.2
report={'status':'MAC_NATIVE_AND_REFERENCE_VISIBLE' if passed else 'HOLD_BLANK_OR_WHITE_ARTWORK_FOR_REVIEW','pdfSHA256':digest,'bytes':len(body),'nativeBackend':'macOS CoreGraphics','referenceBackend':'PDFium','pagesChecked':[1],'nativeStddev':nativeStd,'referenceStddev':referenceStd,'rendererSourceSHA256':codeSHA,'originalUnchanged':source.read_bytes()==body,'semanticVisualReview':False}
if len(sys.argv)>3:
 report['imagePair']=verify_pair(sys.argv[3],source);passed=passed and report['imagePair']['status']=='NUMERICAL_COMPOSITION_MATCH'
 if not passed:report['status']='HOLD_NATIVE_OR_PIXEL_PAIR_REVIEW'
(out/'result.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report));raise SystemExit(0 if passed else 2)
