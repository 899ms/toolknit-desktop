/// Window command domain marker. Native implementations remain in lib.rs until
/// their shared state is moved behind an owned application context.
#[allow(dead_code)]
pub const DOMAIN: &str = "window";
