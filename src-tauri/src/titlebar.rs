//! macOS: places the native window buttons inside our own title bar.
//!
//! `trafficLightPosition` in tauri.conf.json is applied by tao only when its
//! content view redraws, which barely happens because the webview covers it,
//! so the buttons stay glued to the top-left corner. We position them
//! ourselves on start and whenever AppKit may have reset them.

use objc2_app_kit::{NSWindow, NSWindowButton};

/// Left inset of the close button, in points.
const INSET_X: f64 = 20.0;
/// Height of our title bar (`.titlebar` in styles.css); buttons are centered in it.
const TITLEBAR_HEIGHT: f64 = 38.0;

pub fn place_traffic_lights(window: &tauri::Window) {
    let Ok(ptr) = window.ns_window() else { return };
    if ptr.is_null() {
        return;
    }
    // Window events and setup run on the main thread, as AppKit requires.
    let ns_window = unsafe { &*(ptr as *const NSWindow) };
    let buttons = [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton]
        .map(|b| ns_window.standardWindowButton(b));
    let [Some(close), Some(mini), Some(zoom)] = buttons else { return };
    let Some(container) = (unsafe { close.superview() }).and_then(|v| unsafe { v.superview() }) else { return };

    // Stretch the native title bar container to our title bar's height…
    let mut bar = container.frame();
    bar.size.height = TITLEBAR_HEIGHT;
    bar.origin.y = ns_window.frame().size.height - TITLEBAR_HEIGHT;
    container.setFrame(bar);

    // …and center the buttons in it. AppKit views count y from the bottom, so
    // the vertical position has to be set explicitly; only moving x (as tao's
    // `trafficLightPosition` does) leaves them glued to the top edge.
    let close_frame = close.frame();
    let spacing = mini.frame().origin.x - close_frame.origin.x;
    let spacing = if spacing > 0.0 { spacing } else { 20.0 };
    let y = ((TITLEBAR_HEIGHT - close_frame.size.height) / 2.0).round();
    for (i, button) in [close, mini, zoom].iter().enumerate() {
        let mut origin = button.frame().origin;
        origin.x = INSET_X + i as f64 * spacing;
        origin.y = y;
        button.setFrameOrigin(origin);
    }
}
