import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const TRAY_ICON_44 = fileURLToPath(new URL("../../assets/tray-icon-44.png", import.meta.url));
const TRAY_ICON_TEMPLATE = fileURLToPath(new URL("../../assets/tray-icon-template.png", import.meta.url));
const TRAY_ICON_ICO = fileURLToPath(new URL("../../assets/tray-icon.ico", import.meta.url));

// Keep the D-Bus owner in a child: its stdin closes when the OMP process exits,
// so the session bus removes the item even after an unclean shutdown.
const linuxHelper = String.raw`
import sys, os
from gi.repository import Gio, GLib
xml = '''<node><interface name="org.kde.StatusNotifierItem">
<method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
<method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
<method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
<method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method>
<property name="Category" type="s" access="read"/><property name="Id" type="s" access="read"/>
<property name="Title" type="s" access="read"/><property name="Status" type="s" access="read"/>
<property name="IconName" type="s" access="read"/><property name="IconPixmap" type="a(iiay)" access="read"/>
<property name="ToolTip" type="(sa(iiay)ss)" access="read"/><property name="ItemIsMenu" type="b" access="read"/>
</interface></node>'''
loop = GLib.MainLoop()
try:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    iface = Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0]
    tooltip = sys.argv[1]
    def method(conn, sender, path, interface, name, args, invocation):
        if name == 'Activate':
            print('click', flush=True)
        invocation.return_value(None)
    # StatusNotifier pixmaps are ARGB, independent of desktop icon themes.
    fallback = [(16, 16, bytes([255, 42, 84, 145] * (16 * 16)))]
    def load_pixmaps():
        path = os.environ.get('OMP_TRAY_ICON', '')
        if not path:
            return fallback
        try:
            from gi.repository import GdkPixbuf
            source = GdkPixbuf.Pixbuf.new_from_file(path)
            out = []
            for size in (22, 44):
                scaled = source.scale_simple(size, size, GdkPixbuf.InterpType.BILINEAR)
                channels = scaled.get_n_channels()
                pixels = scaled.get_pixels()
                stride = scaled.get_rowstride()
                argb = bytearray(size * size * 4)
                for y in range(size):
                    for x in range(size):
                        offset = y * stride + x * channels
                        if channels == 4:
                            a, r, g, b = pixels[offset + 3], pixels[offset], pixels[offset + 1], pixels[offset + 2]
                        else:
                            a, r, g, b = 255, pixels[offset], pixels[offset + 1], pixels[offset + 2]
                        target = (y * size + x) * 4
                        argb[target:target + 4] = bytes((a, r, g, b))
                out.append((size, size, bytes(argb)))
            return out
        except Exception:
            return fallback
    pixmaps = load_pixmaps()
    def prop(conn, sender, path, interface, name):
        values = {'Category': ('s', 'ApplicationStatus'), 'Id': ('s', 'herd-omp-ui'),
          'Title': ('s', tooltip), 'Status': ('s', 'Active'),
          'IconName': ('s', ''), 'IconPixmap': ('a(iiay)', pixmaps),
          'ToolTip': ('(sa(iiay)ss)', ('', [], tooltip, 'Open DeerFlow Web')),
          'ItemIsMenu': ('b', False)}
        sig, val = values[name]
        return GLib.Variant(sig, val)
    reg = bus.register_object('/StatusNotifierItem', iface, method, prop, None)
    bus.call_sync('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher',
        'org.kde.StatusNotifierWatcher', 'RegisterStatusNotifierItem',
        GLib.Variant('(s)', (bus.get_unique_name(),)), None, Gio.DBusCallFlags.NONE, 5000, None)
    def stdin_closed(source, condition):
        if condition & (GLib.IO_HUP | GLib.IO_ERR):
            loop.quit()
            return False
        if not os.read(0, 1024):
            loop.quit()
            return False
        return True
    GLib.io_add_watch(0, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, stdin_closed)
    print('ready', flush=True)
    loop.run()
    bus.unregister_object(reg)
except Exception as error:
    print(str(error), file=sys.stderr, flush=True)
    sys.exit(1)
`;

const windowsHelper = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$tooltip = $env:OMP_TRAY_TOOLTIP
$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false
$form.WindowState = 'Minimized'
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = if ($env:OMP_TRAY_ICON -and (Test-Path $env:OMP_TRAY_ICON)) { New-Object System.Drawing.Icon($env:OMP_TRAY_ICON) } else { [System.Drawing.SystemIcons]::Application }
$icon.Text = $tooltip
$icon.Visible = $true
$icon.add_MouseClick({ if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Write-Output 'click' } })
$watcher = [System.Threading.Thread]{ while ($true) { if ([Console]::In.Read() -lt 0) { $form.Close(); break } } }
$watcher.IsBackground = $true
$watcher.Start()
Write-Output 'ready'
[System.Windows.Forms.Application]::Run($form)
$icon.Visible = $false
$icon.Dispose()
`;

const macHelper = String.raw`
import AppKit
import Foundation
class Handler: NSObject { @objc func click() { print("click"); fflush(stdout) } }
let handler = Handler()
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
if let path = ProcessInfo.processInfo.environment["OMP_TRAY_ICON"], let image = NSImage(contentsOfFile: path) {
  image.size = NSSize(width: 18, height: 18)
  image.isTemplate = true
  item.button?.image = image
}
item.button?.toolTip = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "DeerFlow Web"
item.button?.target = handler
item.button?.action = #selector(Handler.click)
DispatchQueue.global(qos: .utility).async { while readLine(strippingNewline: true) != nil {}; DispatchQueue.main.async { app.terminate(nil) } }
print("ready"); fflush(stdout)
app.run()
`;

function launch({ command, args, onClick, env }) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: env ? { ...process.env, ...env } : process.env });
		let settled = false;
		let errors = "";
		const lines = createInterface({ input: child.stdout });
		const timer = setTimeout(() => { if (!settled) { settled = true; child.kill(); reject(new Error("System tray startup timed out")); } }, 7000);
		child.stderr.on("data", (data) => { errors = (errors + data.toString()).slice(-2000); });
		lines.on("line", (line) => {
			if (line === "ready" && !settled) { settled = true; clearTimeout(timer); child.unref(); child.stdin.unref?.(); child.stdout.unref?.(); child.stderr.unref?.(); resolve(child); }
			else if (line === "click") onClick();
		});
		child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
		child.on("exit", () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(errors.trim() || "System tray exited")); } });
	});
}

/** Cross-platform tray adapter. `create` is asynchronous and must be awaited. */
export const systemTray = {
	create({ tooltip, onClick }) {
		if (process.platform === "linux") return launch({ command: "python3", args: ["-u", "-c", linuxHelper, tooltip], env: { OMP_TRAY_ICON: TRAY_ICON_44 }, onClick });
		if (process.platform === "win32") {
			const encoded = Buffer.from(windowsHelper, "utf16le").toString("base64");
			return launch({ command: "powershell.exe", args: ["-NoProfile", "-STA", "-EncodedCommand", encoded], env: { OMP_TRAY_TOOLTIP: tooltip, OMP_TRAY_ICON: TRAY_ICON_ICO }, onClick });
		}
		if (process.platform === "darwin") {
			const directory = mkdtempSync(join(tmpdir(), "omp-tray-"));
			const script = join(directory, "tray.swift");
			writeFileSync(script, macHelper);
			return launch({ command: "swift", args: [script, tooltip], env: { OMP_TRAY_ICON: TRAY_ICON_TEMPLATE }, onClick }).finally(() => rmSync(directory, { recursive: true, force: true }));
		}
		return Promise.reject(new Error(`System tray is not implemented for ${process.platform}`));
	},
	async destroy(handle) {
		if (!handle || handle.exitCode !== null || handle.signalCode !== null) return;
		await new Promise((resolve) => {
			let done = false;
			const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
			handle.once("exit", finish);
			const timer = setTimeout(() => { handle.kill(); finish(); }, 1500);
			try { if (!handle.stdin.destroyed) handle.stdin.end(); } catch { handle.kill(); finish(); }
			if (handle.exitCode !== null || handle.signalCode !== null) finish();
		});
	},
};
