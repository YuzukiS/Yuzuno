// The Portal (T-5): importing this module registers its shell, so the first
// open shows it. Entries open things only through these.
import "./Portal";
export { closePortal, mintPreview, openInPortal, openOutside, reaches, usePortal } from "./portal-state";
export type { PortalTarget, PreviewSource } from "./portal-state";
