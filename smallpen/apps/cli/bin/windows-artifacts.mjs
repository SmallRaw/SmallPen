import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { SmallPenError } from "@smallpen/core";

// Use the Windows ACL API: POSIX mkdir modes do not protect Windows files.
// Paths are JSON on stdin, never interpolated into executable PowerShell code.
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$items = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($item in $items) {
  $path = $item.path
  $attributes = [System.IO.File]::GetAttributes($path)
  if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point is not a private CLI directory' }
  $existing = [System.IO.Directory]::GetAccessControl($path)
  $owner = $existing.GetOwner([System.Security.Principal.SecurityIdentifier])
  if (-not $item.created -and $owner.Value -ne $sid.Value) { throw 'CLI directory belongs to another Windows user' }
  $rules = $existing.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  if ($existing.AreAccessRulesProtected -and $owner.Value -eq $sid.Value -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid.Value -and $rules[0].AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $rules[0].FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and $rules[0].InheritanceFlags -eq [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit') { continue }
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
  [System.IO.Directory]::SetAccessControl($path, $security)
  $actual = [System.IO.Directory]::GetAccessControl($path)
  if ($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'CLI ACL owner was not set' }
  if (-not $actual.AreAccessRulesProtected) { throw 'CLI ACL still inherits access rules' }
  foreach ($access in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($access.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $access.IdentityReference.Value -ne $sid.Value) { throw 'CLI directory grants another user access' }
  }
}
`;

export function secureWindowsDirectories(items) {
  try {
    execFileSync(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        input: JSON.stringify(items),
        timeout: 10000,
        maxBuffer: 65536,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch {
    throw new SmallPenError(
      "artifact_directory_unavailable",
      "Windows could not grant and verify private writable access to the CLI temporary directory",
      {
        path: items.at(-1).path,
        recovery:
          "Use a writable NTFS temporary directory and Windows PowerShell, or choose a retained --output file outside the CLI temporary tree.",
      },
    );
  }
}
