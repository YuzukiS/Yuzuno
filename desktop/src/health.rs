//! Whether an address answered as a Yuzuno Core (its `/api/health`). A Core
//! names itself with `product: "yuzuno"`. Cores from before that field
//! (core.10 and older) send only `application: "yuzuno-next"`, which current
//! Cores still send too, for desktop apps up to 0.2.0 that require it.
//! No dependencies, so `rustc --test` checks it without Tauri.

/// The product a Core names in its health response.
pub const PRODUCT: &str = "yuzuno";
/// What a Core from before `product` sends instead.
pub const LEGACY_APPLICATION: &str = "yuzuno-next";

/// A Core of this product: by its `product`, or, when it sends none, by the
/// identifier earlier Cores send.
pub fn is_core(product: Option<&str>, application: Option<&str>) -> bool {
    match product {
        Some(product) => product == PRODUCT,
        None => application == Some(LEGACY_APPLICATION),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_core_is_known_by_its_product_or_by_the_identifier_older_cores_send() {
        // This Core and later ones.
        assert!(is_core(Some("yuzuno"), Some("yuzuno-next")));
        assert!(is_core(Some("yuzuno"), None));
        // core.10 and older send only the identifier.
        assert!(is_core(None, Some("yuzuno-next")));
        // Something else.
        assert!(!is_core(None, None));
        assert!(!is_core(None, Some("yuzuno")));
        assert!(!is_core(Some("other"), Some("yuzuno-next")), "a named product is taken at its word");
        assert!(!is_core(Some("Yuzuno"), None));
    }
}
