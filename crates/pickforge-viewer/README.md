# pickforge-viewer

`pickforge-viewer` shows one Pickforge lab session in a small native window on Linux. It reads the session's own Xvfb display through MIT-SHM and DAMAGE, so it needs no VNC server, bridge or browser. After the host grants control, it sends the human's pointer and keyboard input to the session through XTEST.

A viewer host starts the binary and talks to it over stdio. `PROTOCOL.md` is the contract. `pickforge-viewer --version` prints the version, and `pickforge-viewer --self-test` runs checks that need no display.

The window uses winit and softbuffer with no GPU. The capture and scaling modules have no window code, so tests run them against a bare Xvfb. On Linux, `cargo test -p pickforge-viewer` starts Xvfb servers on random free displays from 10000 to 50000. The window tests open the viewer on a second Xvfb, never on the host desktop. The tests skip when Xvfb is missing, unless `PICKFORGE_REQUIRE_XVFB=1` is set. Set `PICKFORGE_VIEWER_SCREENSHOTS=<dir>` to save PNG captures of the viewer window.

The labels use Geist Medium by The Geist Project Authors, embedded under the SIL Open Font License 1.1 in `assets/OFL.txt`. Colors come from the Pickforge design tokens.
