//! macOS: the copy is dragged as its file URL, the form Finder drags a file
//! in and apps take a dropped file by, in a dragging session of the window's
//! content view, with the file's own icon. Copy only, so nothing that takes
//! it can move the copy. The session runs on after this returns; its source
//! says how it ended.

use super::Outcome;
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject},
    AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSApp, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource, NSEvent,
    NSEventModifierFlags, NSEventType, NSView, NSWindow, NSWorkspace,
};
use objc2_foundation::{
    ns_string, NSArray, NSDictionary, NSPoint, NSRect, NSSize, NSString, NSURLQuarantinePropertiesKey, NSURL,
};
use std::{
    cell::{Cell, RefCell},
    path::Path,
};
use tauri::WebviewWindow;
use tokio::sync::oneshot;

/// macOS drags files out.
pub const READY: bool = true;

/// The size the file's icon is dragged at, in points: the size Finder's
/// own icons are drawn at in a list.
const ICON_POINTS: f64 = 32.0;

type Done = oneshot::Sender<Result<Outcome, String>>;

struct Ivars {
    done: Cell<Option<Done>>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and this class
    // implements no Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "YuzunoFileDragSource"]
    #[ivars = Ivars]
    struct Source;

    // SAFETY: NSObjectProtocol has no safety requirements.
    unsafe impl NSObjectProtocol for Source {}

    // SAFETY: both methods have the signatures AppKit calls them with.
    unsafe impl NSDraggingSource for Source {
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        fn operation_mask(
            &self,
            _session: &NSDraggingSession,
            _context: NSDraggingContext,
        ) -> NSDragOperation {
            NSDragOperation::Copy
        }

        #[unsafe(method(draggingSession:endedAtPoint:operation:))]
        fn ended(
            &self,
            _session: &NSDraggingSession,
            _screen_point: NSPoint,
            operation: NSDragOperation,
        ) {
            if let Some(done) = self.ivars().done.take() {
                let outcome = if operation == NSDragOperation::None { Outcome::Cancelled } else { Outcome::Dropped };
                let _ = done.send(Ok(outcome));
            }
        }
    }
);

impl Source {
    fn new(mtm: MainThreadMarker, done: Done) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars { done: Cell::new(Some(done)) });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

thread_local! {
    /// The last drag's source, kept while its session may still call it;
    /// the next drag's takes its place (one drag at a time).
    static KEPT: RefCell<Option<Retained<Source>>> = const { RefCell::new(None) };
}

/// Drags the copy from the main window, on its thread, until it is dropped
/// or let go.
pub async fn start(window: &WebviewWindow, path: &Path, _source: &str) -> Result<Outcome, String> {
    let (done, outcome) = oneshot::channel();
    let target = window.clone();
    let path = path.to_owned();
    window
        .run_on_main_thread(move || begin(&target, &path, done))
        .map_err(|e| e.to_string())?;
    outcome.await.map_err(|_| "The drag did not start.".to_owned())?
}

fn begin(window: &WebviewWindow, path: &Path, done: Done) {
    let Some(mtm) = MainThreadMarker::new() else {
        let _ = done.send(Err("A drag can start only on the main thread.".into()));
        return;
    };
    // The primary button: bit 0 of the buttons held now.
    if (NSEvent::pressedMouseButtons() & 1) == 0 {
        let _ = done.send(Ok(Outcome::Released));
        return;
    }
    let (view, items, event) = match prepare(window, path, mtm) {
        Ok(prepared) => prepared,
        Err(error) => {
            let _ = done.send(Err(error));
            return;
        }
    };
    let source = Source::new(mtm, done);
    let _session = view.beginDraggingSessionWithItems_event_source(&items, &event, ProtocolObject::from_ref(&*source));
    KEPT.with(|kept| *kept.borrow_mut() = Some(source));
}

type Prepared = (Retained<NSView>, Retained<NSArray<NSDraggingItem>>, Retained<NSEvent>);

fn prepare(window: &WebviewWindow, path: &Path, mtm: MainThreadMarker) -> Result<Prepared, String> {
    let text = path.to_str().ok_or("macOS could not name the file to drag.")?;
    let text = NSString::from_str(text);
    let url = NSURL::fileURLWithPath_isDirectory(&text, false);
    mark(&url);
    let ns_window = window.ns_window().map_err(|e| e.to_string())?;
    // SAFETY: Tauri's live NSWindow of this window, used only on the main
    // thread (checked by the caller) and only during this call.
    let ns_window: &NSWindow = unsafe { &*ns_window.cast::<NSWindow>() };
    let view = ns_window.contentView().ok_or("The window has no view to drag from.")?;
    let pointer = view.convertPoint_fromView(ns_window.mouseLocationOutsideOfEventStream(), None);
    let item = NSDraggingItem::initWithPasteboardWriter(NSDraggingItem::alloc(), ProtocolObject::from_ref(&*url));
    let icon = NSWorkspace::sharedWorkspace().iconForFile(&text);
    let frame = NSRect::new(
        NSPoint::new(pointer.x - ICON_POINTS / 2.0, pointer.y - ICON_POINTS / 2.0),
        NSSize::new(ICON_POINTS, ICON_POINTS),
    );
    let contents: &AnyObject = &icon;
    // SAFETY: an NSImage, which a dragging item's contents may be.
    unsafe { item.setDraggingFrame_contents(frame, Some(contents)) };
    // The drag starts from a drag of the pointer where it is now, as AppKit
    // starts one from a mouse-dragged event.
    let timestamp = NSApp(mtm).currentEvent().map_or(0.0, |event| event.timestamp());
    let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        NSEventType::LeftMouseDragged,
        ns_window.mouseLocationOutsideOfEventStream(),
        NSEventModifierFlags(0),
        timestamp,
        ns_window.windowNumber(),
        None,
        0,
        1,
        1.0,
    )
    .ok_or("macOS could not start a drag here.")?;
    Ok((view, NSArray::from_retained_slice(&[item]), event))
}

/// Marks the copy as a download, as a browser does (the quarantine
/// properties Launch Services reads), so an app or page an Agent made is
/// opened from it with the same check as one downloaded in a browser. The
/// key strings are Launch Services' own constants' values.
fn mark(url: &NSURL) {
    let properties = NSDictionary::from_slices(
        &[ns_string!("LSQuarantineAgentName"), ns_string!("LSQuarantineType")],
        &[ns_string!("Yuzuno"), ns_string!("LSQuarantineTypeWebDownload")],
    );
    let value: &AnyObject = &properties;
    // SAFETY: a dictionary of strings is the value this key takes, and the
    // key is Foundation's own constant.
    if let Err(error) = unsafe { url.setResourceValue_forKey_error(Some(value), NSURLQuarantinePropertiesKey) } {
        eprintln!("Unable to mark a dragged file as downloaded: {error:?}");
    }
}
