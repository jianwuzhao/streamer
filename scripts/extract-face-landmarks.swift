import Foundation
import CoreImage
import Vision

do {
    guard CommandLine.arguments.count == 3,
          let image = CIImage(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])) else { throw CocoaError(.fileReadCorruptFile) }
    let request = VNDetectFaceLandmarksRequest()
    request.constellation = .constellation76Points
    try VNImageRequestHandler(ciImage: image).perform([request])
    guard let face = request.results?.max(by: { $0.boundingBox.width < $1.boundingBox.width }),
          face.confidence > 0.7, let marks = face.landmarks else { throw CocoaError(.fileReadCorruptFile) }
    let regions: [String: VNFaceLandmarkRegion2D?] = ["contour": marks.faceContour, "nose": marks.nose,
        "noseCrest": marks.noseCrest, "leftEye": marks.leftEye, "rightEye": marks.rightEye,
        "leftBrow": marks.leftEyebrow, "rightBrow": marks.rightEyebrow,
        "leftPupil": marks.leftPupil, "rightPupil": marks.rightPupil,
        "outerLips": marks.outerLips, "innerLips": marks.innerLips, "median": marks.medianLine]
    var points: [String: [[Double]]] = [:]
    let box = face.boundingBox
    for (name, region) in regions {
        guard let region = region else { continue }
        points[name] = region.normalizedPoints.map { [Double(box.minX + CGFloat($0.x) * box.width), Double(1 - box.minY - CGFloat($0.y) * box.height)] }
    }
    let result: [String: Any] = ["width": Int(image.extent.width), "height": Int(image.extent.height),
        "confidence": face.confidence, "landmarks": points]
    try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]).write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
} catch {
    FileHandle.standardError.write(Data("无法提取完整面部标记：\(error.localizedDescription)\n".utf8)); exit(1)
}
