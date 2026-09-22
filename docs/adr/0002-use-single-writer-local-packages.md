# Use single-writer local Packages

SmallPen Alpha supports Packages opened from a local filesystem and allows Desktop to observe Agent changes live, but only one surface may commit a change at a time. Network filesystems, actively synchronized folders, and automatic multi-writer merging are outside the supported editing boundary because process-local locks and revision checks cannot provide Penpot-style collaboration semantics across machines; conflicts are rejected rather than silently overwritten.
