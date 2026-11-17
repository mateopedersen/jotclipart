"""Integration regression against a retained real failing PDF and real macOS reader.
Usage: bundled-python tests/pdf-native-compatibility.py original.pdf repaired.pdf receipt.json native-renderer
"""
import io,json,hashlib,subprocess,sys,tempfile
from pathlib import Path
import pypdfium2 as pdfium
from PIL import Image,ImageStat
from pypdf import PdfReader
original,repaired,receipt,renderer=map(Path,sys.argv[1:])
source=original.read_bytes();target=repaired.read_bytes();proof=json.loads(receipt.read_text())
assert hashlib.sha256(source).hexdigest()==proof['sourceSHA256']
assert hashlib.sha256(target).hexdigest()==proof['sha256'] and len(target)==proof['bytes']<=1_000_000
assert proof['sampleRMSE']<=1.8 and proof['originalAlphaPreserved'] and proof['fullResolutionPreserved']
before,after=PdfReader(io.BytesIO(source)),PdfReader(io.BytesIO(target))
assert len(before.pages)==len(after.pages)==1 and list(before.pages[0].mediabox)==list(after.pages[0].mediabox)
for name,obj in before.pages[0]['/Resources']['/XObject'].items():
 x=obj.get_object();y=after.pages[0]['/Resources']['/XObject'][name].get_object()
 for key in ['/Width','/Height','/BitsPerComponent']:assert x[key]==y[key]
 if x.get('/SMask'):
  assert x['/SMask'].get_object().get_data()==y['/SMask'].get_object().get_data()
  assert hashlib.sha256(y['/SMask'].get_object().get_data()).hexdigest()==proof['originalAlphaSHA256']
 assert y['/Filter']!='/JPXDecode'
with tempfile.TemporaryDirectory(prefix='jot-pdf-regression-') as tmp:
 results={}
 for label,path in [('before',original),('after',repaired)]:
  png=Path(tmp)/(label+'.png');subprocess.run([str(renderer.resolve()),'pdf',str(path.resolve()),str(png)],check=True)
  results[label]=ImageStat.Stat(Image.open(png).convert('RGB')).stddev
 assert max(results['before'])<0.01,'Fixture must reproduce the original native blank'
 assert max(results['after'])>1,'Repair remains blank in the real native reader'
 doc=pdfium.PdfDocument(target);page=doc[0];ref=page.render(scale=384/max(page.get_size())).to_pil()
 assert max(ImageStat.Stat(ref.convert('RGB')).stddev)>1,'Repair is blank in PDFium'
assert original.read_bytes()==source,'Original modified during regression'
print(json.dumps({'status':'REAL_NATIVE_BLANK_REGRESSION_PASSED','native':results,'fullResolution':True,'exactOriginalAlpha':True,'originalUnchanged':True,'sizeLimit':True,'sampleQualityBound':True}))
