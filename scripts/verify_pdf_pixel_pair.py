"""Numerical composition comparison only; never a semantic artwork review."""
import hashlib,io,json
from pathlib import Path
import numpy as np
from PIL import Image,ImageOps
import pypdfium2 as pdfium

def normalized(image):
    rgba=image.convert('RGBA');white=Image.new('RGBA',rgba.size,'white');white.alpha_composite(rgba)
    small=ImageOps.contain(white.convert('RGB'),(384,384),Image.Resampling.LANCZOS)
    canvas=Image.new('RGB',(384,384),'white');canvas.paste(small,((384-small.width)//2,(384-small.height)//2));return np.asarray(canvas).astype(float)

def verify_pair(image_path,pdf_path):
    image_bytes=Path(image_path).read_bytes();pdf_bytes=Path(pdf_path).read_bytes()
    image=Image.open(io.BytesIO(image_bytes));image.load()
    doc=pdfium.PdfDocument(pdf_bytes)
    if len(doc)!=1:raise ValueError('One-page artwork pair required')
    page=doc[0];aspect_image=image.width/image.height;aspect_pdf=page.get_width()/page.get_height()
    aspect_error=abs(aspect_pdf/aspect_image-1)
    source=normalized(image);rendered=normalized(page.render(scale=384/max(page.get_size())).to_pil())
    difference=source-rendered
    rmse=float(np.sqrt(np.mean(difference**2)));mae=float(np.mean(np.abs(difference)))
    left=source.mean(axis=2).ravel();right=rendered.mean(axis=2).ravel()
    if left.std()<.1 or right.std()<.1:raise ValueError('Blank pair cannot establish matching artwork')
    correlation=float(np.corrcoef(left,right)[0,1])
    passed=aspect_error<=.01 and rmse<=30 and mae<=20 and correlation>=.92
    return {'status':'NUMERICAL_COMPOSITION_MATCH' if passed else 'HOLD_FOR_VISUAL_PAIR_REVIEW','imageSHA256':hashlib.sha256(image_bytes).hexdigest(),'pdfSHA256':hashlib.sha256(pdf_bytes).hexdigest(),'aspectRelativeError':aspect_error,'normalizedRGBRMSE':rmse,'normalizedRGBMeanAbsoluteError':mae,'luminanceCorrelation':correlation,'method':'384px white-composited full-canvas comparison; not semantic identification'}
