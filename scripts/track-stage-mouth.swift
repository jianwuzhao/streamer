import AVFoundation
import CoreMedia
import CryptoKit
import Foundation
import Vision

private struct StageTrackError: LocalizedError {
    var errorDescription: String? { "素材缺少连续可用的嘴部标记" }
}

@main
struct TrackStageMouth {
    static func main() async throws {
        let args = CommandLine.arguments
        guard args.count == 3 else { throw StageTrackError() }
        let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw StageTrackError() }
        let reader = try AVAssetReader(asset: asset)
        let format: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: format)
        output.alwaysCopiesSampleData = false
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? StageTrackError() }

        let request = VNDetectFaceLandmarksRequest()
        request.constellation = .constellation76Points
        var next = 0.0
        var attempted = 0
        var frames: [[Double]] = []
        while let sample = output.copyNextSampleBuffer() {
            let time = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            guard time >= next - 0.001, let image = CMSampleBufferGetImageBuffer(sample) else { continue }
            next = time + 1.0 / 15.0
            attempted += 1
            try VNImageRequestHandler(cvPixelBuffer: image, orientation: .up).perform([request])
            guard let face = request.results?.max(by: { $0.boundingBox.width < $1.boundingBox.width }),
                  face.confidence >= 0.75, let marks = face.landmarks, let outline = marks.outerLips else { continue }
            let rect = face.boundingBox
            func normalized(_ region: VNFaceLandmarkRegion2D) -> [CGPoint] {
                region.normalizedPoints.map { CGPoint(x: rect.minX + $0.x * rect.width, y: 1 - rect.minY - $0.y * rect.height) }
            }
            let outer = normalized(outline)
            guard let left = outer.min(by: { $0.x < $1.x }), let right = outer.max(by: { $0.x < $1.x }) else { continue }
            let span = right.x - left.x
            guard span > 0.009 else { continue }
            let centerX = (left.x + right.x) / 2
            let middle = marks.innerLips.map(normalized)?.filter { abs($0.x - centerX) < span * 0.26 } ?? []
            let centerY = middle.isEmpty ? (left.y + right.y) / 2 : middle.map(\.y).reduce(0,+) / CGFloat(middle.count)
            let tilt = atan2((right.y - left.y) * CGFloat(CVPixelBufferGetHeight(image)),
                             span * CGFloat(CVPixelBufferGetWidth(image)))
            let row = [time, Double(centerX), Double(centerY), Double(span), Double(tilt)]
            frames.append(row.map { ($0 * 100000).rounded() / 100000 })
        }
        guard reader.status == .completed, frames.count >= 2, frames.count * 10 >= attempted * 9,
              zip(frames, frames.dropFirst()).allSatisfy({ $1[0] - $0[0] < 0.22 }) else { throw StageTrackError() }
        let source = try Data(contentsOf: URL(fileURLWithPath: args[1]), options: .mappedIfSafe)
        let sha256 = SHA256.hash(data: source).map { String(format: "%02x", $0) }.joined()
        let outputJSON: [String: Any] = ["sha256": sha256, "frames": frames]
        let data = try JSONSerialization.data(withJSONObject: outputJSON, options: [.sortedKeys])
        try data.write(to: URL(fileURLWithPath: args[2]), options: .atomic)
        print("\(frames.count) frames")
    }
}
