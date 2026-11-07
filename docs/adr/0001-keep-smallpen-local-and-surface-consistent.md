# Keep SmallPen local and surface-consistent

The current SmallPen product is a local AI-assisted workspace: an Agent authors through the CLI, while a person observes and intervenes through Desktop backed by the Local Web Host. A remotely Hosted Web Service is deferred as a separate product boundary because it requires authentication, storage, isolation, and collaboration semantics; within the local product, every delivery surface must resolve the same Package, Foundation, Libraries, snapshots, warnings, and Repair state so Agent output and human inspection cannot diverge.
