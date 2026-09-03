use std::collections::HashSet;
use std::sync::Mutex;

/// Small process-local registry used to prevent duplicate long-running jobs.
#[derive(Default)]
pub struct TaskRegistry(Mutex<HashSet<String>>);

impl TaskRegistry {
    pub fn claim(&self, id: impl Into<String>) -> bool {
        self.0.lock().map(|mut tasks| tasks.insert(id.into())).unwrap_or(false)
    }
    pub fn release(&self, id: &str) {
        if let Ok(mut tasks) = self.0.lock() { tasks.remove(id); }
    }
}

#[cfg(test)]
mod tests {
    use super::TaskRegistry;

    #[test]
    fn duplicate_claims_are_rejected_until_release() {
        let registry = TaskRegistry::default();
        assert!(registry.claim("job"));
        assert!(!registry.claim("job"));
        registry.release("job");
        assert!(registry.claim("job"));
    }
}
