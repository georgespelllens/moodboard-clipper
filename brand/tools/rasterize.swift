import AppKit

// Renders an SVG (or any image NSImage reads) into a PNG of the given size, keeping transparency.
// Usage: rasterize <in.svg> <size|WIDTHxHEIGHT> <out.png>
let args = CommandLine.arguments
let parts = args.count == 4 ? args[2].split(separator: "x", omittingEmptySubsequences: false).map { Int($0) } : []
guard (1...2).contains(parts.count), parts.allSatisfy({ ($0 ?? 0) > 0 }) else {
  FileHandle.standardError.write("usage: rasterize <in.svg> <size|WIDTHxHEIGHT> <out.png>\n".data(using: .utf8)!)
  exit(2)
}
let width = parts[0]!, height = parts.last!!
guard let image = NSImage(contentsOf: URL(fileURLWithPath: args[1])) else {
  FileHandle.standardError.write("cannot read \(args[1])\n".data(using: .utf8)!)
  exit(1)
}
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                           bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: width, height: height)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current?.imageInterpolation = .high
image.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
NSGraphicsContext.restoreGraphicsState()
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[3]))
