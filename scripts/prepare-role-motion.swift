import CoreImage
import CoreVideo
import Foundation
import Vision

do {
    let arguments = CommandLine.arguments
    guard (arguments.count == 4 || arguments.count == 5),
          let portrait = CIImage(contentsOf: URL(fileURLWithPath: arguments[1])),
          let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
        throw CocoaError(.fileReadCorruptFile)
    }

    let request = VNGeneratePersonSegmentationRequest()
    request.qualityLevel = .accurate
    request.outputPixelFormat = kCVPixelFormatType_OneComponent8
    try VNImageRequestHandler(ciImage: portrait).perform([request])
    guard let result = request.results?.first else { throw CocoaError(.fileReadCorruptFile) }

    let extent = portrait.extent
    let mask = CIImage(cvPixelBuffer: result.pixelBuffer)
    let aligned = mask.transformed(by: CGAffineTransform(
        scaleX: extent.width / mask.extent.width,
        y: extent.height / mask.extent.height
    ))
    // Leave a static margin inside the silhouette so shifted pixels never sample the room.
    let alpha = aligned.clampedToExtent()
        .applyingFilter("CIColorThreshold", parameters: ["inputThreshold": 0.76])
        .applyingFilter("CIMorphologyMinimum", parameters: [kCIInputRadiusKey: extent.width * 0.04])
        .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: extent.width * 0.005])
        .applyingFilter("CIMaskToAlpha")
        .cropped(to: extent)
    let context = CIContext()
    try context.writePNGRepresentation(
        of: alpha, to: URL(fileURLWithPath: arguments[2]), format: .RGBA8, colorSpace: colorSpace
    )
    // Keep the full head outline. A small expansion retains thin strands and accessory edges.
    let silhouette = aligned.clampedToExtent()
        .applyingFilter("CIMorphologyMaximum", parameters: [kCIInputRadiusKey: 1.5])
        .applyingFilter("CIMaskToAlpha")
        .cropped(to: extent)
    try context.writePNGRepresentation(
        of: silhouette, to: URL(fileURLWithPath: arguments[3]), format: .RGBA8, colorSpace: colorSpace
    )
    if arguments.count == 5 {
        let landmarks = VNDetectFaceLandmarksRequest()
        try VNImageRequestHandler(ciImage: portrait).perform([landmarks])
        var eyes: [[String: Double]] = []
        if let face = landmarks.results?.max(by: { $0.boundingBox.width < $1.boundingBox.width }),
           face.confidence > 0.7 {
            for region in [face.landmarks?.leftEye, face.landmarks?.rightEye] {
                guard let points = region?.normalizedPoints, points.count >= 4 else { continue }
                let box = face.boundingBox
                let xs = points.map { box.minX + CGFloat($0.x) * box.width }
                let ys = points.map { 1 - (box.minY + CGFloat($0.y) * box.height) }
                let minX = xs.min()!, maxX = xs.max()!, minY = ys.min()!, maxY = ys.max()!
                let left = xs.firstIndex(of: minX)!, right = xs.firstIndex(of: maxX)!
                eyes.append(["x": Double((minX + maxX) / 2), "y": Double((minY + maxY) / 2),
                    "width": Double(maxX - minX), "height": Double(maxY - minY),
                    "tilt": atan2(Double((ys[right] - ys[left]) * extent.height), Double((maxX - minX) * extent.width))])
            }
        }
        try JSONSerialization.data(withJSONObject: eyes.count == 2 ? eyes : []).write(to: URL(fileURLWithPath: arguments[4]))
    }
} catch {
    FileHandle.standardError.write(Data("角色轮廓生成失败：\(error.localizedDescription)\n".utf8))
    exit(1)
}
