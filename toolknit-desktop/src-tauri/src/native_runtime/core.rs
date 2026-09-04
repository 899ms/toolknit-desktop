use super::*;

// Core native responsibilities are grouped by their stable ownership boundary.
// Re-exports keep the parent command registry compatible while child modules
// can evolve independently.
pub(super) mod picker { use super::*; include!("core/picker.rs"); }
pub(super) use picker::*;
pub(super) mod window { use super::*; include!("core/window.rs"); }
pub(super) use window::*;
pub(super) mod security { include!("core/security.rs"); }
pub(super) use security::*;
pub(super) mod fonts { use super::*; include!("core/fonts.rs"); }
pub(super) use fonts::*;
pub(super) mod storage { use super::*; include!("core/storage.rs"); }
pub(super) use storage::*;
pub(super) mod background { use super::*; include!("core/background.rs"); }
pub(super) use background::*;
pub(super) mod install { include!("core/install.rs"); }
pub(super) use install::*;
