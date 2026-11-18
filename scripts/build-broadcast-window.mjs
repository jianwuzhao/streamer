import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin") {
	const root = dirname(dirname(fileURLToPath(import.meta.url)));
	const app = join(root, "lib", "DafeiyuBroadcast.app");
	const contents = join(app, "Contents");
	const macos = join(contents, "MacOS");
	const temp = mkdtempSync(join(tmpdir(), "dafeiyu-window-build-"));
	const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
	try {
		rmSync(app, { recursive: true, force: true });
		mkdirSync(macos, { recursive: true });
		const slices = ["arm64", "x86_64"].map((arch) => {
			const output = join(temp, arch);
			run("/usr/bin/xcrun", ["swiftc", "-O", "-parse-as-library", "-target", arch + "-apple-macos13.0",
				"-module-cache-path", join(temp, "modules"), join(root, "scripts", "broadcast-window.swift"),
				"-o", output]);
			return output;
		});
		run("/usr/bin/xcrun", ["lipo", "-create", ...slices, "-output", join(macos, "DafeiyuBroadcast")]);
		writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.dafeiyu.broadcast</string>
  <key>CFBundleExecutable</key><string>DafeiyuBroadcast</string>
  <key>CFBundleName</key><string>大肥鱼直播画面</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`);
		run("/usr/bin/codesign", ["--force", "--sign", "-", app]);
	} catch (error) {
		rmSync(app, { recursive: true, force: true });
		throw error;
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}
