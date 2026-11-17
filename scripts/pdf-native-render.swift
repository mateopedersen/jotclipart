import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
let args=CommandLine.arguments
guard args.count == 4 else { fatalError("kind input output") }
let input=URL(fileURLWithPath:args[2]) as CFURL
let maxSide=384.0
var rendered: CGImage?
if args[1] == "pdf" {
 guard let doc=CGPDFDocument(input),let page=doc.page(at:1) else {fatalError("Unreadable PDF")}
 let box=page.getBoxRect(.mediaBox),factor=maxSide/max(box.width,box.height)
 guard let ctx=CGContext(data:nil,width:Int(ceil(box.width*factor)),height:Int(ceil(box.height*factor)),bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {fatalError("No context")}
 ctx.setFillColor(CGColor(gray:1,alpha:1));ctx.fill(CGRect(x:0,y:0,width:ctx.width,height:ctx.height))
 ctx.scaleBy(x:factor,y:factor);ctx.translateBy(x:-box.minX,y:-box.minY);ctx.drawPDFPage(page);rendered=ctx.makeImage()
} else {
 guard let source=CGImageSourceCreateWithURL(input,nil) else {fatalError("Unreadable image")}
 let options=[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceThumbnailMaxPixelSize:384,kCGImageSourceCreateThumbnailWithTransform:true] as CFDictionary
 rendered=CGImageSourceCreateThumbnailAtIndex(source,0,options)
}
guard let image=rendered,let out=CGImageDestinationCreateWithURL(URL(fileURLWithPath:args[3]) as CFURL,UTType.png.identifier as CFString,1,nil) else {fatalError("No rendered output")}
CGImageDestinationAddImage(out,image,nil);guard CGImageDestinationFinalize(out) else {fatalError("Write failure")}
