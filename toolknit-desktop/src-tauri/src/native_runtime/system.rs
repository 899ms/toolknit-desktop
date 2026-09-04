use super::*;

#[cfg(target_os = "windows")]
pub(super) const HARDWARE_PROVIDER_PREAMBLE: &str = r#"
$script:__tkProviderMap = @{}
$script:__tkDcomSession = $null
$script:__tkDcomAttempted = $false

function Get-ToolKnitRegistryInstance {
  param([string]$ClassName)
  switch ($ClassName) {
    'Win32_ComputerSystem' {
      $biosKey = 'HKLM:\HARDWARE\DESCRIPTION\System\BIOS'
      $p = Get-ItemProperty -Path $biosKey -ErrorAction SilentlyContinue
      if (-not $p) { return $null }
      $mfg = [string]$p.SystemManufacturer
      $model = [string]$p.SystemProductName
      if (-not $mfg -and -not $model) { return $null }
      return [PSCustomObject]@{ Manufacturer = $mfg; Model = $model; PCSystemType = $null; TotalPhysicalMemory = $null }
    }
    'Win32_OperatingSystem' {
      $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
      $p = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
      if (-not $p) { return $null }
      $caption = [string]$p.ProductName
      if (-not $caption) { $caption = 'Windows' }
      $version = if ($p.DisplayVersion) { [string]$p.DisplayVersion } else { [string]$p.ReleaseId }
      return [PSCustomObject]@{
        Caption = $caption
        Version = $version
        BuildNumber = [string]$p.CurrentBuildNumber
        OSArchitecture = if ([Environment]::Is64BitOperatingSystem) { '64-bit' } else { '32-bit' }
        InstallDate = $null
        LastBootUpTime = $null
        FreePhysicalMemory = $null
        TotalVisibleMemorySize = $null
      }
    }
    'Win32_Processor' {
      $base = 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor'
      $subkeys = @(Get-ChildItem $base -ErrorAction SilentlyContinue)
      $p = Get-ItemProperty -Path "$base\0" -ErrorAction SilentlyContinue
      if (-not $p) { return $null }
      return [PSCustomObject]@{
        Name = [string]$p.ProcessorNameString
        Manufacturer = [string]$p.VendorIdentifier
        NumberOfCores = $null
        NumberOfLogicalProcessors = [int]$subkeys.Count
        VirtualizationFirmwareEnabled = $null
        SocketDesignation = 'CPU'
        AddressWidth = if ([Environment]::Is64BitOperatingSystem) { 64 } else { 32 }
        MaxClockSpeed = [int]$p.'~MHz'
        CurrentClockSpeed = [int]$p.'~MHz'
        L2CacheSize = $null
        L3CacheSize = $null
        VMMonitorModeExtensions = $null
        SecondLevelAddressTranslationExtensions = $null
        LoadPercentage = $null
      }
    }
    'Win32_BaseBoard' {
      $biosKey = 'HKLM:\HARDWARE\DESCRIPTION\System\BIOS'
      $p = Get-ItemProperty -Path $biosKey -ErrorAction SilentlyContinue
      if (-not $p -or (-not $p.BaseBoardProduct -and -not $p.BaseBoardManufacturer)) { return $null }
      return [PSCustomObject]@{ Manufacturer = [string]$p.BaseBoardManufacturer; Product = [string]$p.BaseBoardProduct; Version = [string]$p.BaseBoardVersion; Status = '' }
    }
    'Win32_BIOS' {
      $biosKey = 'HKLM:\HARDWARE\DESCRIPTION\System\BIOS'
      $p = Get-ItemProperty -Path $biosKey -ErrorAction SilentlyContinue
      if (-not $p) { return $null }
      $relDate = $null
      if ($p.BIOSReleaseDate) {
        try { $relDate = [DateTime]::ParseExact([string]$p.BIOSReleaseDate, 'MM/dd/yyyy', $null) } catch {}
      }
      return [PSCustomObject]@{ Manufacturer = [string]$p.BIOSVendor; SMBIOSBIOSVersion = [string]$p.BIOSVersion; ReleaseDate = $relDate; SMBIOSMajorVersion = $null; SMBIOSMinorVersion = $null }
    }
    default { return $null }
  }
}

function Get-ToolKnitInstance {
  param(
    [Parameter(Position=0)][string]$ClassName,
    [string]$Namespace = 'root\cimv2',
    [string]$Filter = $null
  )
  $key = "$($Namespace):$($ClassName)"
  $cimArgs = @{ ClassName = $ClassName; Namespace = $Namespace; ErrorAction = 'Stop' }
  if ($Filter) { $cimArgs.Filter = $Filter }

  if ($null -eq $script:__tkDcomSession -and -not $script:__tkDcomAttempted) {
    $script:__tkDcomAttempted = $true
    try {
      $opt = New-CimSessionOption -Protocol Dcom -ErrorAction Stop
      $script:__tkDcomSession = New-CimSession -ComputerName localhost -SessionOption $opt -ErrorAction Stop
    } catch {}
  }

  if ($null -ne $script:__tkDcomSession) {
    try {
      $items = @(Get-CimInstance -CimSession $script:__tkDcomSession @cimArgs)
      if ($items.Count -gt 0) { $script:__tkProviderMap[$key] = 'cim-dcom'; if ($items.Count -eq 1) { return $items[0] }; return $items }
    } catch {}
  }

  try {
    $items = @(Get-CimInstance @cimArgs)
    if ($items.Count -gt 0) { $script:__tkProviderMap[$key] = 'cim-wsman'; if ($items.Count -eq 1) { return $items[0] }; return $items }
  } catch {}

  try {
    if (Get-Command Get-WmiObject -ErrorAction SilentlyContinue) {
      $wmiArgs = @{ Class = $ClassName; Namespace = $Namespace; ErrorAction = 'Stop' }
      if ($Filter) { $wmiArgs.Filter = $Filter }
      $items = @(Get-WmiObject @wmiArgs)
      if ($items.Count -gt 0) { $script:__tkProviderMap[$key] = 'wmi'; if ($items.Count -eq 1) { return $items[0] }; return $items }
    }
  } catch {}

  try {
    $item = Get-ToolKnitRegistryInstance -ClassName $ClassName
    if ($null -ne $item) { $script:__tkProviderMap[$key] = 'registry'; return $item }
  } catch {}

  $script:__tkProviderMap[$key] = 'unavailable'
  return
}
"#;

#[cfg(target_os = "windows")]
pub(super) const PROVIDER_ATTACH: &str = r#"
if ($script:__tkProviderMap -and $script:__tkProviderMap.Count -gt 0) {
  try {
    $__tk_obj = $__toolknit_payload | ConvertFrom-Json
    if ($__tk_obj -is [pscustomobject]) {
      $__tk_prov = [ordered]@{}
      foreach ($__tk_kv in $script:__tkProviderMap.GetEnumerator() | Sort-Object Key) { $__tk_prov[$__tk_kv.Key] = $__tk_kv.Value }
      $__tk_obj | Add-Member -NotePropertyName providers -NotePropertyValue $__tk_prov -Force
      $__toolknit_payload = $__tk_obj | ConvertTo-Json -Depth 8 -Compress
    }
  } catch {}
}
"#;

#[cfg(all(target_os = "windows", debug_assertions))]
pub(super) fn append_hardware_debug(line: &str) {
    use std::io::Write;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join("toolknit-hardware-debug.log");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "[{}] {}", stamp, line);
    }
}

#[cfg(any(not(target_os = "windows"), not(debug_assertions)))]
pub(super) fn append_hardware_debug(_line: &str) {}

#[cfg(target_os = "windows")]
pub(super) fn run_windows_powershell_json(script: &str, context: &str) -> Result<serde_json::Value, String> {
    use std::os::windows::process::CommandExt;

    let provider_script = script.replace("Get-CimInstance", "Get-ToolKnitInstance");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let out_path = std::env::temp_dir().join(format!(
        "toolknit-hw-out-{}-{}.txt",
        std::process::id(),
        stamp
    ));
    let err_path = std::env::temp_dir().join(format!(
        "toolknit-hw-err-{}-{}.txt",
        std::process::id(),
        stamp
    ));
    let cleanup_paths = || {
        let _ = std::fs::remove_file(&out_path);
        let _ = std::fs::remove_file(&err_path);
    };

    // Write the JSON payload to a temporary file instead of stdout. This avoids
    // fragile console/stdout encoding issues on some Windows builds, and lets us
    // capture a real exception message when the probe fails.
    let wrapped_script = format!(
        r#"
$ErrorActionPreference = 'Stop'
try {{
{0}
$__toolknit_payload = & {{
{1}
}}
if ($null -eq $__toolknit_payload) {{ $__toolknit_payload = '' }}
{2}
$__toolknit_text = ($__toolknit_payload | Out-String).Trim()
Set-Content -LiteralPath $env:TOOLKNIT_HW_OUT -Value ([string]$__toolknit_text) -Encoding UTF8
}} catch {{
Set-Content -LiteralPath $env:TOOLKNIT_HW_ERR -Value $_.Exception.ToString() -Encoding UTF8
exit 1
}}
"#,
        HARDWARE_PROVIDER_PREAMBLE,
        provider_script,
        PROVIDER_ATTACH,
    );

    let output = match std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &wrapped_script,
        ])
        .env("TOOLKNIT_HW_OUT", &out_path)
        .env("TOOLKNIT_HW_ERR", &err_path)
        .creation_flags(0x08000000)
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            cleanup_paths();
            return Err(format!("Cannot start {}: {}", context, error));
        }
    };

    if !output.status.success() || !out_path.exists() {
        let err_text = std::fs::read_to_string(&err_path)
            .unwrap_or_default()
            .trim_start_matches('\u{FEFF}')
            .trim()
            .to_string();
        let err_flat = err_text.replace(['\r', '\n'], " ");
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let exit = output.status.code().unwrap_or(-1);
        let detail = if !err_flat.is_empty() {
            format!(
                "exit={}; error={}",
                exit,
                err_flat.chars().take(700).collect::<String>()
            )
        } else if !stderr.is_empty() {
            format!("exit={}; stderr={}", exit, stderr.chars().take(480).collect::<String>())
        } else {
            format!("exit={}", exit)
        };
        append_hardware_debug(&format!(
            "{} | exit={} | error={} | stderr={}",
            context, exit, err_text, stderr
        ));
        cleanup_paths();
        return Err(format!("{} failed: {}", context, detail));
    }

    let payload = match std::fs::read_to_string(&out_path) {
        Ok(payload) => payload
            .trim_start_matches('\u{FEFF}')
            .trim()
            .to_string(),
        Err(error) => {
            cleanup_paths();
            return Err(format!("{} failed to read output: {}", context, error));
        }
    };
    cleanup_paths();

    if payload.is_empty() {
        append_hardware_debug(&format!("{} | returned no data", context));
        return Err(format!("{} returned no data", context));
    }
    serde_json::from_str(&payload).map_err(|error| {
        append_hardware_debug(&format!(
            "{} | invalid json: {} | payload={}",
            context, error, payload
        ));
        format!("{} returned invalid data: {}", context, error)
    })
}

#[tauri::command]
pub(super) async fn get_hardware_overview() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(collect_hardware_overview)
        .await
        .map_err(|error| format!("Hardware inspection worker failed: {}", error))?
}

#[cfg(target_os = "windows")]
pub(super) fn collect_hardware_overview() -> Result<serde_json::Value, String> {
    // A single read-only PowerShell/CIM request avoids a chain of WMI calls on
    // the UI thread. The payload deliberately excludes serial numbers, UUIDs,
    // account names, MAC addresses, and any other machine-identifying values.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 otherwise writes non-ASCII JSON using the active
# console code page. The Rust process correctly expects UTF-8 JSON.
function Epoch($value) {
  if ($null -eq $value) { return $null }
  try { return [long](($value).ToUniversalTime().Subtract([DateTime]'1970-01-01').TotalMilliseconds) } catch { return $null }
}
function DeviceType($value) {
  switch ([int]$value) {
    1 { 'desktop' }
    2 { 'laptop' }
    3 { 'workstation' }
    4 { 'server' }
    default { 'other' }
  }
}
$computer = Get-CimInstance Win32_ComputerSystem
$system = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$board = Get-CimInstance Win32_BaseBoard | Select-Object -First 1
$bios = Get-CimInstance Win32_BIOS | Select-Object -First 1
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object {
  [ordered]@{ name = [string]$_.Name; driver_version = [string]$_.DriverVersion }
})
$disks = @(Get-CimInstance Win32_DiskDrive | ForEach-Object {
  [ordered]@{ model = [string]$_.Model; size_bytes = [Int64]$_.Size }
})
$volumes = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 3' | ForEach-Object {
  [ordered]@{ id = [string]$_.DeviceID; size_bytes = [Int64]$_.Size; free_bytes = [Int64]$_.FreeSpace }
})
$secureBoot = 'unavailable'
try { if (Confirm-SecureBootUEFI) { $secureBoot = 'enabled' } else { $secureBoot = 'disabled' } } catch {}
$bootMode = if (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State') { 'uefi' } else { 'legacy_or_unavailable' }
$tpm = $null
try { $tpm = Get-Tpm } catch {}
$batteries = @(Get-CimInstance Win32_Battery)
[ordered]@{
  device = [ordered]@{
    manufacturer = [string]$computer.Manufacturer
    model = [string]$computer.Model
    device_type = DeviceType $computer.PCSystemType
  }
  system = [ordered]@{
    caption = [string]$system.Caption
    version = [string]$system.Version
    build = [string]$system.BuildNumber
    architecture = [string]$system.OSArchitecture
    install_at = Epoch $system.InstallDate
    boot_at = Epoch $system.LastBootUpTime
  }
  core = [ordered]@{
    cpu_name = [string]$cpu.Name
    cpu_cores = [int]$cpu.NumberOfCores
    cpu_threads = [int]$cpu.NumberOfLogicalProcessors
    memory_total_bytes = [Int64]$computer.TotalPhysicalMemory
    memory_available_bytes = [Int64]$system.FreePhysicalMemory * 1024
    gpus = $gpus
    disks = $disks
    volumes = $volumes
  }
  firmware = [ordered]@{
    mainboard = @([string]$board.Manufacturer, [string]$board.Product | Where-Object { $_ } ) -join ' '
    bios_version = [string]$bios.SMBIOSBIOSVersion
    bios_release_at = Epoch $bios.ReleaseDate
    boot_mode = $bootMode
    secure_boot = $secureBoot
    tpm_present = [bool]$tpm.TpmPresent
    tpm_ready = [bool]$tpm.TpmReady
    virtualization_enabled = [bool]$cpu.VirtualizationFirmwareEnabled
  }
  battery = [ordered]@{
    status = if ($batteries.Count -gt 0) { 'present' } else { 'not_detected' }
  }
} | ConvertTo-Json -Depth 6 -Compress
"#;

    run_windows_powershell_json(SCRIPT, "Windows hardware inspection")
}

#[cfg(not(target_os = "windows"))]
pub(super) fn collect_hardware_overview() -> Result<serde_json::Value, String> {
    Err("Hardware inspection is currently available on Windows only".to_string())
}

#[tauri::command]
pub(super) async fn get_cpu_memory_info() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(collect_cpu_memory_info)
        .await
        .map_err(|error| format!("CPU and memory inspection worker failed: {}", error))?
}

#[tauri::command]
pub(super) async fn get_cpu_memory_live_stats() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(collect_cpu_memory_live_stats)
        .await
        .map_err(|error| format!("CPU and memory live stats worker failed: {}", error))?
}

#[cfg(target_os = "windows")]
pub(super) fn collect_cpu_memory_info() -> Result<serde_json::Value, String> {
    // Keep identifiers private: memory serial numbers and physical addresses
    // are intentionally not read or included in this local-only payload.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$system = Get-CimInstance Win32_OperatingSystem
$memoryArray = Get-CimInstance Win32_PhysicalMemoryArray | Select-Object -First 1
$memoryModules = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
  [ordered]@{
    slot = [string]$_.DeviceLocator
    bank = [string]$_.BankLabel
    manufacturer = [string]$_.Manufacturer
    part_number = [string]$_.PartNumber
    capacity_bytes = [Int64]$_.Capacity
    speed_mhz = [int]$_.Speed
    configured_clock_mhz = [int]$_.ConfiguredClockSpeed
    smbios_memory_type = [int]$_.SMBIOSMemoryType
  }
})
$perfCpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1
$perfMemory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object -First 1
$cpuUsage = if ($null -ne $perfCpu -and $null -ne $perfCpu.PercentProcessorTime) { [int]$perfCpu.PercentProcessorTime } else { [int]$cpu.LoadPercentage }
$availableBytes = if ($null -ne $perfMemory -and $null -ne $perfMemory.AvailableBytes) { [Int64]$perfMemory.AvailableBytes } else { [Int64]$system.FreePhysicalMemory * 1024 }
[ordered]@{
  cpu = [ordered]@{
    name = [string]$cpu.Name
    manufacturer = [string]$cpu.Manufacturer
    socket = [string]$cpu.SocketDesignation
    address_width = [int]$cpu.AddressWidth
    cores = [int]$cpu.NumberOfCores
    threads = [int]$cpu.NumberOfLogicalProcessors
    max_clock_mhz = [int]$cpu.MaxClockSpeed
    current_clock_mhz = [int]$cpu.CurrentClockSpeed
    l2_cache_kb = [int]$cpu.L2CacheSize
    l3_cache_kb = [int]$cpu.L3CacheSize
    virtualization_firmware_enabled = [bool]$cpu.VirtualizationFirmwareEnabled
    vm_monitor_extensions = [bool]$cpu.VMMonitorModeExtensions
    slat_extensions = [bool]$cpu.SecondLevelAddressTranslationExtensions
  }
  memory = [ordered]@{
    total_bytes = [Int64]$system.TotalVisibleMemorySize * 1024
    available_bytes = $availableBytes
    slots_reported = [int]$memoryArray.MemoryDevices
    error_correction_code = [int]$memoryArray.MemoryErrorCorrection
    modules = $memoryModules
  }
  current = [ordered]@{
    cpu_usage_percent = $cpuUsage
    memory_available_bytes = $availableBytes
    committed_bytes = if ($null -ne $perfMemory) { [Int64]$perfMemory.CommittedBytes } else { 0 }
    commit_limit_bytes = if ($null -ne $perfMemory) { [Int64]$perfMemory.CommitLimit } else { 0 }
  }
} | ConvertTo-Json -Depth 6 -Compress
"#;

    run_windows_powershell_json(SCRIPT, "CPU and memory inspection")
}

#[cfg(target_os = "windows")]
pub(super) fn collect_cpu_memory_live_stats() -> Result<serde_json::Value, String> {
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$system = Get-CimInstance Win32_OperatingSystem
$perfCpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1
$perfMemory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object -First 1
[ordered]@{
  cpu_usage_percent = if ($null -ne $perfCpu -and $null -ne $perfCpu.PercentProcessorTime) { [int]$perfCpu.PercentProcessorTime } else { [int]$cpu.LoadPercentage }
  memory_available_bytes = if ($null -ne $perfMemory -and $null -ne $perfMemory.AvailableBytes) { [Int64]$perfMemory.AvailableBytes } else { [Int64]$system.FreePhysicalMemory * 1024 }
  committed_bytes = if ($null -ne $perfMemory) { [Int64]$perfMemory.CommittedBytes } else { 0 }
  commit_limit_bytes = if ($null -ne $perfMemory) { [Int64]$perfMemory.CommitLimit } else { 0 }
} | ConvertTo-Json -Compress
"#;

    run_windows_powershell_json(SCRIPT, "CPU and memory live stats")
}

#[cfg(not(target_os = "windows"))]
pub(super) fn collect_cpu_memory_info() -> Result<serde_json::Value, String> {
    Err("CPU and memory inspection is currently available on Windows only".to_string())
}

#[cfg(not(target_os = "windows"))]
pub(super) fn collect_cpu_memory_live_stats() -> Result<serde_json::Value, String> {
    Err("CPU and memory inspection is currently available on Windows only".to_string())
}

#[derive(serde::Serialize)]
pub(super) struct DxgiAdapterInfo {
    description: String,
    vendor_id: u32,
    device_id: u32,
    dedicated_video_memory: u64,
    shared_system_memory: u64,
    flags: u32,
}

#[derive(serde::Serialize)]
pub(super) struct ActiveDisplayConfiguration {
    adapter_name: String,
    device_name: String,
    monitor_key: String,
    width: u32,
    height: u32,
    refresh_hz: u32,
}

#[tauri::command]
pub(super) async fn get_gpu_display_info() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(collect_gpu_display_info)
        .await
        .map_err(|error| format!("GPU and display inspection worker failed: {}", error))?
}

#[cfg(target_os = "windows")]
pub(super) fn collect_gpu_display_info() -> Result<serde_json::Value, String> {
    // WMI supplies display EDID and driver metadata. DXGI and GDI below are
    // intentionally used for data WMI cannot represent correctly, especially
    // dedicated memory on modern GPUs and per-display refresh rates.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
function DecodeWmiText($values) {
  if ($null -eq $values) { return '' }
  return (($values | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join '').Trim()
}
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object {
  [ordered]@{
    name = [string]$_.Name
    video_processor = [string]$_.VideoProcessor
    driver_version = [string]$_.DriverVersion
    driver_date = if ($_.DriverDate) { ([DateTime]$_.DriverDate).ToString('yyyy-MM-dd') } else { '' }
  }
})
$basicByInstance = @{}
Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams | Where-Object { $_.Active } | ForEach-Object { $basicByInstance[$_.InstanceName] = $_ }
$connectionByInstance = @{}
Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorConnectionParams | Where-Object { $_.Active } | ForEach-Object { $connectionByInstance[$_.InstanceName] = $_ }
$monitors = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID | Where-Object { $_.Active } | ForEach-Object {
  $basic = $basicByInstance[$_.InstanceName]
  $connection = $connectionByInstance[$_.InstanceName]
  $displayKey = if ([string]$_.InstanceName -match 'DISPLAY\\([^\\]+)') { $Matches[1] } else { '' }
  [ordered]@{
    display_key = $displayKey
    manufacturer = DecodeWmiText $_.ManufacturerName
    model = DecodeWmiText $_.UserFriendlyName
    product_code = DecodeWmiText $_.ProductCodeID
    width_cm = if ($basic) { [int]$basic.MaxHorizontalImageSize } else { 0 }
    height_cm = if ($basic) { [int]$basic.MaxVerticalImageSize } else { 0 }
    connection_code = if ($null -ne $connection -and $null -ne $connection.VideoOutputTechnology) {
      try { [Int64]$connection.VideoOutputTechnology } catch { [Int64]-1 }
    } else { [Int64]-1 }
  }
})
[ordered]@{ gpus = $gpus; monitors = $monitors } | ConvertTo-Json -Depth 5 -Compress
"#;

    let mut value = run_windows_powershell_json(SCRIPT, "GPU and display inspection")?;
    let object = value
        .as_object_mut()
        .ok_or("GPU and display inspection returned an invalid payload")?;
    object.insert(
        "dxgi_adapters".to_string(),
        serde_json::to_value(enumerate_dxgi_adapters()).map_err(|error| error.to_string())?,
    );
    object.insert(
        "display_configurations".to_string(),
        serde_json::to_value(enumerate_active_displays()).map_err(|error| error.to_string())?,
    );
    Ok(value)
}

#[cfg(target_os = "windows")]
pub(super) fn utf16z_to_string(value: &[u16]) -> String {
    let end = value
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(value.len());
    String::from_utf16_lossy(&value[..end]).trim().to_string()
}

#[cfg(target_os = "windows")]
pub(super) fn windows_display_match_key(value: &str) -> String {
    let uppercase = value.to_ascii_uppercase();
    for prefix in ["MONITOR\\", "DISPLAY\\", "MONITOR#", "DISPLAY#"] {
        if let Some(start) = uppercase.find(prefix) {
            let rest = &value[start + prefix.len()..];
            let end = rest
                .find(|character| character == '\\' || character == '#')
                .unwrap_or(rest.len());
            return rest[..end].trim().to_string();
        }
    }
    String::new()
}

#[cfg(target_os = "windows")]
pub(super) fn enumerate_dxgi_adapters() -> Vec<DxgiAdapterInfo> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_DESC1};

    let factory: IDXGIFactory1 = match unsafe { CreateDXGIFactory1() } {
        Ok(factory) => factory,
        Err(error) => {
            log::warn!("DXGI adapter enumeration is unavailable: {}", error);
            return Vec::new();
        }
    };
    let mut adapters = Vec::new();
    for index in 0..32_u32 {
        let adapter = match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => adapter,
            Err(_) => break,
        };
        let mut description = DXGI_ADAPTER_DESC1::default();
        if unsafe { adapter.GetDesc1(&mut description) }.is_err() {
            continue;
        }
        adapters.push(DxgiAdapterInfo {
            description: utf16z_to_string(&description.Description),
            vendor_id: description.VendorId,
            device_id: description.DeviceId,
            dedicated_video_memory: description.DedicatedVideoMemory as u64,
            shared_system_memory: description.SharedSystemMemory as u64,
            flags: description.Flags,
        });
    }
    adapters
}

#[cfg(target_os = "windows")]
pub(super) fn enumerate_active_displays() -> Vec<ActiveDisplayConfiguration> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayDevicesW, EnumDisplaySettingsW, DEVMODEW, DISPLAY_DEVICEW,
        DISPLAY_DEVICE_ATTACHED_TO_DESKTOP, ENUM_CURRENT_SETTINGS,
    };

    let mut displays = Vec::new();
    for index in 0..32_u32 {
        let mut adapter = DISPLAY_DEVICEW::default();
        adapter.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
        if !unsafe { EnumDisplayDevicesW(None, index, &mut adapter, 0) }.as_bool() {
            break;
        }
        if adapter.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP == 0 {
            continue;
        }
        let mut mode = DEVMODEW::default();
        mode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        if !unsafe {
            EnumDisplaySettingsW(
                PCWSTR(adapter.DeviceName.as_ptr()),
                ENUM_CURRENT_SETTINGS,
                &mut mode,
            )
        }
        .as_bool()
        {
            continue;
        }
        let mut monitor = DISPLAY_DEVICEW::default();
        monitor.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
        let has_monitor =
            unsafe { EnumDisplayDevicesW(PCWSTR(adapter.DeviceName.as_ptr()), 0, &mut monitor, 0) }
                .as_bool();
        displays.push(ActiveDisplayConfiguration {
            adapter_name: utf16z_to_string(&adapter.DeviceString),
            device_name: utf16z_to_string(&adapter.DeviceName),
            monitor_key: if has_monitor {
                windows_display_match_key(&utf16z_to_string(&monitor.DeviceID))
            } else {
                String::new()
            },
            width: mode.dmPelsWidth,
            height: mode.dmPelsHeight,
            refresh_hz: mode.dmDisplayFrequency,
        });
    }
    displays
}

#[cfg(not(target_os = "windows"))]
pub(super) fn collect_gpu_display_info() -> Result<serde_json::Value, String> {
    Err("GPU and display inspection is currently available on Windows only".to_string())
}

#[tauri::command]
pub(super) async fn get_mainboard_firmware_info() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(collect_mainboard_firmware_info)
        .await
        .map_err(|error| format!("Mainboard and firmware inspection worker failed: {}", error))?
}

#[cfg(target_os = "windows")]
pub(super) fn collect_mainboard_firmware_info() -> Result<serde_json::Value, String> {
    // This inventory intentionally leaves out board serial numbers, UUIDs,
    // PnP instance paths, and any other machine-identifying values. Windows
    // exposes PCI device names and status without needing those identifiers.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
function Epoch($value) {
  if ($null -eq $value) { return $null }
  try { return [long](($value).ToUniversalTime().Subtract([DateTime]'1970-01-01').TotalMilliseconds) } catch { return $null }
}
$board = Get-CimInstance Win32_BaseBoard | Select-Object -First 1
$bios = Get-CimInstance Win32_BIOS | Select-Object -First 1
$computer = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$enclosure = Get-CimInstance Win32_SystemEnclosure | Select-Object -First 1
$secureBoot = 'unavailable'
try { if (Confirm-SecureBootUEFI) { $secureBoot = 'enabled' } else { $secureBoot = 'disabled' } } catch {}
$bootMode = if (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State') { 'uefi' } else { 'legacy_or_unavailable' }
$tpm = $null
try { $tpm = Get-Tpm } catch {}
$rawPci = @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'PCI\*' } | Sort-Object PNPClass, Name)
$pciDevices = @($rawPci | Group-Object { "$($_.PNPClass)`u001f$($_.Name)`u001f$($_.Manufacturer)`u001f$($_.Status)`u001f$($_.ConfigManagerErrorCode)" } | ForEach-Object {
  $sample = $_.Group | Select-Object -First 1
  [ordered]@{
    name = [string]$sample.Name
    manufacturer = [string]$sample.Manufacturer
    pnp_class = [string]$sample.PNPClass
    status = [string]$sample.Status
    problem_code = [int]$sample.ConfigManagerErrorCode
    count = [int]$_.Count
  }
} | Select-Object -First 40)
[ordered]@{
  board = [ordered]@{
    manufacturer = [string]$board.Manufacturer
    product = [string]$board.Product
    version = [string]$board.Version
    status = [string]$board.Status
  }
  firmware = [ordered]@{
    manufacturer = [string]$bios.Manufacturer
    bios_version = [string]$bios.SMBIOSBIOSVersion
    release_at = Epoch $bios.ReleaseDate
    smbios_major = [int]$bios.SMBIOSMajorVersion
    smbios_minor = [int]$bios.SMBIOSMinorVersion
    boot_mode = $bootMode
  }
  security = [ordered]@{
    secure_boot = $secureBoot
    tpm_present = [bool]$tpm.TpmPresent
    tpm_ready = [bool]$tpm.TpmReady
    tpm_manufacturer = ([string]$tpm.ManufacturerIdTxt).Trim([char]0)
    virtualization_enabled = [bool]$cpu.VirtualizationFirmwareEnabled
  }
  chassis = [ordered]@{
    types = @($enclosure.ChassisTypes | ForEach-Object { [int]$_ })
    manufacturer = [string]$computer.Manufacturer
    model = [string]$computer.Model
  }
  pci_devices = $pciDevices
} | ConvertTo-Json -Depth 6 -Compress
"#;

    run_windows_powershell_json(SCRIPT, "Mainboard and firmware inspection")
}

#[cfg(not(target_os = "windows"))]
pub(super) fn collect_mainboard_firmware_info() -> Result<serde_json::Value, String> {
    Err("Mainboard and firmware inspection is currently available on Windows only".to_string())
}

#[tauri::command]
pub(super) async fn get_storage_health_info() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(collect_storage_health_info)
        .await
        .map_err(|error| format!("Storage and health inspection worker failed: {}", error))?
}

#[cfg(target_os = "windows")]
pub(super) fn collect_storage_health_info() -> Result<serde_json::Value, String> {
    // Storage serials and volume labels are deliberately excluded. The page
    // needs only non-identifying capacity, health, and reliability data.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
function MaybeInt($value) {
  if ($null -eq $value) { return $null }
  return [Int64]$value
}
$physicalDisks = @()
try { $physicalDisks = @(Get-PhysicalDisk) } catch {}
$physicalById = @{}
foreach ($physical in $physicalDisks) { $physicalById[[string]$physical.DeviceId] = $physical }
$reliabilityById = @{}
if ($physicalDisks.Count -gt 0) {
  foreach ($physical in $physicalDisks) {
    try { @(Get-StorageReliabilityCounter -PhysicalDisk $physical) | ForEach-Object {
      $reliabilityById[[string]$_.DeviceId] = $_
    } } catch {}
  }
}
$disks = @()
try { $disks = @(Get-Disk | ForEach-Object {
  $disk = $_
  $physical = $physicalById[[string]$disk.Number]
  if ($null -eq $physical) {
    $physical = $physicalDisks | Where-Object { $_.FriendlyName -eq $disk.FriendlyName } | Select-Object -First 1
  }
  $reliability = if ($physical) { $reliabilityById[[string]$physical.DeviceId] } else { $reliabilityById[[string]$disk.Number] }
  [ordered]@{
    number = [int]$disk.Number
    friendly_name = if ($physical) { [string]$physical.FriendlyName } else { [string]$disk.FriendlyName }
    media_type = if ($physical) { [string]$physical.MediaType } else { '' }
    bus_type = if ($physical) { [string]$physical.BusType } else { [string]$disk.BusType }
    size_bytes = [Int64]$disk.Size
    firmware_version = if ($physical) { [string]$physical.FirmwareVersion } else { '' }
    partition_style = [string]$disk.PartitionStyle
    health_status = if ($physical -and $physical.HealthStatus) { [string]$physical.HealthStatus } else { [string]$disk.HealthStatus }
    operational_status = if ($physical -and $physical.OperationalStatus) { @($physical.OperationalStatus) -join ', ' } else { @($disk.OperationalStatus) -join ', ' }
    is_system = [bool]$disk.IsSystem
    is_boot = [bool]$disk.IsBoot
    is_offline = [bool]$disk.IsOffline
    reliability = [ordered]@{
      temperature_c = if ($reliability -and $null -ne $reliability.Temperature) { MaybeInt $reliability.Temperature } else { $null }
      wear_percent = if ($reliability -and $null -ne $reliability.Wear) { MaybeInt $reliability.Wear } else { $null }
      power_on_hours = if ($reliability -and $null -ne $reliability.PowerOnHours) { MaybeInt $reliability.PowerOnHours } else { $null }
      read_errors_total = if ($reliability -and $null -ne $reliability.ReadErrorsTotal) { MaybeInt $reliability.ReadErrorsTotal } else { $null }
      write_errors_total = if ($reliability -and $null -ne $reliability.WriteErrorsTotal) { MaybeInt $reliability.WriteErrorsTotal } else { $null }
    }
  }
}) } catch {}
$volumes = @()
try { $volumes = @(Get-Volume | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Fixed' } | Sort-Object DriveLetter | ForEach-Object {
  [ordered]@{
    drive_letter = [string]$_.DriveLetter
    file_system = [string]$_.FileSystem
    size_bytes = [Int64]$_.Size
    free_bytes = [Int64]$_.SizeRemaining
    health_status = [string]$_.HealthStatus
  }
}) } catch {}
[ordered]@{ disks = $disks; volumes = $volumes } | ConvertTo-Json -Depth 6 -Compress
"#;

    run_windows_powershell_json(SCRIPT, "Storage and health inspection")
}

#[cfg(not(target_os = "windows"))]
pub(super) fn collect_storage_health_info() -> Result<serde_json::Value, String> {
    Err("Storage and health inspection is currently available on Windows only".to_string())
}

#[tauri::command]
pub(super) async fn get_network_devices_info() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(collect_network_devices_info)
        .await
        .map_err(|error| format!("Network and device inspection worker failed: {}", error))?
}

#[cfg(target_os = "windows")]
pub(super) fn collect_network_devices_info() -> Result<serde_json::Value, String> {
    // Deliberately exclude addresses and identifiers: IP, MAC, Bluetooth
    // address, device instance path, and serial values do not help this page.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
function GroupDevices($items) {
  return @($items | Group-Object { "$($_.name)`u001f$($_.manufacturer)`u001f$($_.status)" } | ForEach-Object {
    $sample = $_.Group | Select-Object -First 1
    [ordered]@{
      name = [string]$sample.name
      manufacturer = [string]$sample.manufacturer
      status = [string]$sample.status
      count = [int]$_.Count
    }
  } | Select-Object -First 40)
}
$networkAdapters = @()
try { $networkAdapters = @(Get-NetAdapter -IncludeHidden | Where-Object { $_.Status -ne 'Not Present' } | ForEach-Object {
  [ordered]@{
    name = [string]$_.Name
    description = [string]$_.InterfaceDescription
    status = [string]$_.Status
    link_speed = [string]$_.LinkSpeed
    physical = [bool]$_.HardwareInterface
  }
}) } catch {}
$bluetoothRaw = @(Get-CimInstance Win32_PnPEntity | Where-Object {
  $_.PNPClass -eq 'Bluetooth' -and $_.Present -and $_.Name -notmatch '(?i)(service|profile|enumerator|rfcomm|服务|配置文件|枚举器)'
} | ForEach-Object { [ordered]@{ name = [string]$_.Name; manufacturer = [string]$_.Manufacturer; status = [string]$_.Status } })
$usbRaw = @(Get-CimInstance Win32_PnPEntity | Where-Object {
  $_.PNPClass -eq 'USB' -and $_.Present
} | ForEach-Object { [ordered]@{ name = [string]$_.Name; manufacturer = [string]$_.Manufacturer; status = [string]$_.Status } })
$cameraRaw = @(Get-CimInstance Win32_PnPEntity | Where-Object {
  $_.PNPClass -in @('Camera', 'Image') -and $_.Present
} | ForEach-Object { [ordered]@{ name = [string]$_.Name; manufacturer = [string]$_.Manufacturer; status = [string]$_.Status } })
$audioRaw = @(Get-CimInstance Win32_SoundDevice | ForEach-Object {
  [ordered]@{ name = [string]$_.Name; manufacturer = [string]$_.Manufacturer; status = [string]$_.Status }
})
[ordered]@{
  network_adapters = $networkAdapters
  bluetooth_devices = GroupDevices $bluetoothRaw
  audio_devices = GroupDevices $audioRaw
  usb_devices = GroupDevices $usbRaw
  cameras = GroupDevices $cameraRaw
} | ConvertTo-Json -Depth 6 -Compress
"#;

    run_windows_powershell_json(SCRIPT, "Network and device inspection")
}

#[cfg(not(target_os = "windows"))]
pub(super) fn collect_network_devices_info() -> Result<serde_json::Value, String> {
    Err("Network and device inspection is currently available on Windows only".to_string())
}

#[tauri::command]
pub(super) async fn get_power_sensors_info() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(collect_power_sensors_info)
        .await
        .map_err(|error| format!("Power and sensor inspection worker failed: {}", error))?
}

#[cfg(target_os = "windows")]
pub(super) fn collect_power_sensors_info() -> Result<serde_json::Value, String> {
    // Battery serial numbers, power-plan GUIDs, and sensor instance paths are
    // deliberately omitted. This page only needs human-readable read-only data.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
function MaybeInt($value) {
  if ($null -eq $value) { return $null }
  return [Int64]$value
}
function MaybeFloat($value) {
  if ($null -eq $value) { return $null }
  return [double]$value
}
function CelsiusFromAcpi($value) {
  if ($null -eq $value -or [double]$value -le 0) { return $null }
  return [double]("{0:F1}" -f (([double]$value / 10.0) - 273.15))
}
function BatteryStatusName($value) {
  switch ([int]$value) {
    1 { 'other' }
    2 { 'unknown' }
    3 { 'fully_charged' }
    4 { 'low' }
    5 { 'critical' }
    6 { 'charging' }
    7 { 'charging_high' }
    8 { 'charging_low' }
    9 { 'charging_critical' }
    10 { 'undefined' }
    11 { 'partially_charged' }
    default { 'unknown' }
  }
}
$activePlan = Get-CimInstance -Namespace root\cimv2\power -ClassName Win32_PowerPlan | Where-Object { $_.IsActive } | Select-Object -First 1
$batteryStatic = @(Get-CimInstance -Namespace root\wmi -ClassName BatteryStaticData)
$batteryFull = @(Get-CimInstance -Namespace root\wmi -ClassName BatteryFullChargedCapacity)
$batteries = @(Get-CimInstance Win32_Battery)
$batteryItems = @()
for ($i = 0; $i -lt $batteries.Count; $i++) {
  $battery = $batteries[$i]
  $static = if ($i -lt $batteryStatic.Count) { $batteryStatic[$i] } else { $null }
  $full = if ($i -lt $batteryFull.Count) { $batteryFull[$i] } else { $null }
  $designCapacity = if ($static -and $null -ne $static.DesignedCapacity) { MaybeInt $static.DesignedCapacity } else { $null }
  $fullCapacity = if ($full -and $null -ne $full.FullChargedCapacity) { MaybeInt $full.FullChargedCapacity } else { $null }
  $health = if ($designCapacity -and $designCapacity -gt 0 -and $fullCapacity -and $fullCapacity -gt 0) { [int](($fullCapacity / $designCapacity) * 100 + 0.5) } else { $null }
  $batteryItems += [ordered]@{
    name = [string]$battery.Name
    status = BatteryStatusName $battery.BatteryStatus
    status_code = MaybeInt $battery.BatteryStatus
    charge_percent = MaybeInt $battery.EstimatedChargeRemaining
    estimated_run_time_min = if ($battery.EstimatedRunTime -and [int]$battery.EstimatedRunTime -lt 71582788) { MaybeInt $battery.EstimatedRunTime } else { $null }
    design_capacity_mwh = $designCapacity
    full_charge_capacity_mwh = $fullCapacity
    health_percent = $health
  }
}
$thermalZones = @(Get-CimInstance -Namespace root\wmi -ClassName MSAcpi_ThermalZoneTemperature | ForEach-Object -Begin { $zoneIndex = 0 } -Process {
  $zoneIndex += 1
  [ordered]@{
    name = "ACPI Thermal Zone $zoneIndex"
    source = 'acpi'
    current_c = CelsiusFromAcpi $_.CurrentTemperature
    critical_c = CelsiusFromAcpi $_.CriticalTripPoint
    passive_c = CelsiusFromAcpi $_.PassiveTripPoint
  }
})
$fans = @(Get-CimInstance Win32_Fan | ForEach-Object {
  [ordered]@{
    name = [string]$_.Name
    status = [string]$_.Status
    desired_speed_rpm = MaybeInt $_.DesiredSpeed
    active_cooling = if ($null -ne $_.ActiveCooling) { [bool]$_.ActiveCooling } else { $null }
  }
})
[ordered]@{
  power_plan = [ordered]@{
    name = if ($activePlan) { [string]$activePlan.ElementName } else { '' }
    caption = if ($activePlan) { [string]$activePlan.Caption } else { '' }
    active = [bool]($activePlan -and $activePlan.IsActive)
  }
  batteries = $batteryItems
  thermal_zones = $thermalZones
  fans = $fans
} | ConvertTo-Json -Depth 6 -Compress
"#;

    run_windows_powershell_json(SCRIPT, "Power and sensor inspection")
}

#[cfg(not(target_os = "windows"))]
pub(super) fn collect_power_sensors_info() -> Result<serde_json::Value, String> {
    Err("Power and sensor inspection is currently available on Windows only".to_string())
}

#[tauri::command]
pub(super) async fn scan_large_files(
    root_path: String,
    min_size_mb: Option<u64>,
    mode: Option<String>,
) -> Result<LargeFileScanResult, String> {
    tokio::task::spawn_blocking(move || collect_large_files(root_path, min_size_mb, mode))
        .await
        .map_err(|error| format!("Large file scan worker failed: {}", error))?
}

pub(super) fn collect_large_files(
    root_path: String,
    min_size_mb: Option<u64>,
    mode: Option<String>,
) -> Result<LargeFileScanResult, String> {
    let root = canonical_scan_root(&root_path)?;
    let min_size_mb = min_size_mb.unwrap_or(50).clamp(10, 102_400);
    let min_size_bytes = min_size_mb.saturating_mul(1024 * 1024);
    let mode = normalize_large_file_mode(mode.as_deref());
    let mut scanned_files = 0_u64;
    let mut skipped_dirs = 0_u64;
    let mut candidates = Vec::new();
    let mut stack = vec![root.clone()];
    const MAX_SCAN_FILES: u64 = 250_000;
    const MAX_RESULTS: usize = 1200;

    while let Some(directory) = stack.pop() {
        if should_skip_cleanup_dir(&directory, &root) {
            skipped_dirs += 1;
            continue;
        }
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                skipped_dirs += 1;
                continue;
            }
        };
        for entry in entries.flatten() {
            if scanned_files >= MAX_SCAN_FILES {
                break;
            }
            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.is_dir() {
                stack.push(path);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            scanned_files += 1;
            let size_bytes = metadata.len();
            if size_bytes < min_size_bytes {
                continue;
            }
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let category = cleanup_file_category(&extension);
            if category == "other" || !cleanup_mode_allows(&mode, category) {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                continue;
            }
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|duration| i64::try_from(duration.as_millis()).ok());
            let (risk, local_reason) = cleanup_local_risk(&path, category, size_bytes);
            candidates.push(LargeFileCandidate {
                id: format!("lf-{}", candidates.len() + 1),
                path: cleanup_display_path(&path),
                name,
                extension,
                category: category.to_string(),
                size_bytes,
                modified_at,
                folder_hint: cleanup_folder_hint(&path, &root),
                risk,
                local_reason,
            });
            if candidates.len() >= MAX_RESULTS {
                break;
            }
        }
        if scanned_files >= MAX_SCAN_FILES || candidates.len() >= MAX_RESULTS {
            break;
        }
    }

    candidates.sort_by(|a, b| {
        b.size_bytes
            .cmp(&a.size_bytes)
            .then_with(|| a.name.cmp(&b.name))
    });
    let drive_space = cleanup_drive_space_from_path(&cleanup_display_path(&root))
        .ok()
        .flatten();
    Ok(LargeFileScanResult {
        root_path: cleanup_display_path(&root),
        min_size_bytes,
        mode,
        scanned_files,
        skipped_dirs,
        drive_space,
        candidates,
    })
}

#[tauri::command]
pub(super) fn get_cleanup_drive_space(root_path: String) -> Result<Option<CleanupDriveSpace>, String> {
    cleanup_drive_space_from_path(&root_path)
}

#[cfg(target_os = "windows")]
pub(super) fn cleanup_drive_space_from_path(root_path: &str) -> Result<Option<CleanupDriveSpace>, String> {
    use std::os::windows::process::CommandExt;

    if root_path.contains('\0') {
        return Err("Invalid drive path".to_string());
    }
    let Some(drive) = cleanup_drive_root_letter_from_input(root_path) else {
        return Ok(None);
    };
    let script = format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='{}:'" | Select-Object -First 1
if ($null -ne $disk) {{
  [ordered]@{{ drive = '{}:\'; free_bytes = [Int64]$disk.FreeSpace; total_bytes = [Int64]$disk.Size }} | ConvertTo-Json -Compress
}}
"#,
        drive, drive
    );
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags(0x08000000)
        .output()
        .map_err(|error| format!("Cannot read drive space: {}", error))?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr)
            .trim()
            .replace(['\r', '\n'], " ");
        return Err(if details.is_empty() {
            "Cannot read drive space".to_string()
        } else {
            format!(
                "Cannot read drive space: {}",
                details.chars().take(240).collect::<String>()
            )
        });
    }
    let payload = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if payload.is_empty() {
        return Ok(None);
    }
    serde_json::from_str::<CleanupDriveSpace>(&payload)
        .map(Some)
        .map_err(|error| format!("Drive space returned invalid data: {}", error))
}

#[cfg(not(target_os = "windows"))]
pub(super) fn cleanup_drive_space_from_path(_root_path: &str) -> Result<Option<CleanupDriveSpace>, String> {
    Ok(None)
}

#[cfg(target_os = "windows")]
pub(super) fn cleanup_drive_root_letter_from_input(root_path: &str) -> Option<char> {
    let trimmed = root_path.trim();
    let without_verbatim = trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed);
    let bytes = without_verbatim.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        let rest = &without_verbatim[2..];
        if rest.is_empty() || rest.chars().all(|ch| ch == '\\' || ch == '/') {
            return Some((bytes[0] as char).to_ascii_uppercase());
        }
    }
    cleanup_drive_root_letter(std::path::Path::new(root_path))
}

pub(super) fn canonical_scan_root(root_path: &str) -> Result<std::path::PathBuf, String> {
    if root_path.contains('\0') {
        return Err("Invalid scan folder".to_string());
    }
    let root = std::path::PathBuf::from(root_path)
        .canonicalize()
        .map_err(|error| format!("Cannot access scan folder: {}", error))?;
    if !root.is_dir() {
        return Err("Scan target must be a folder".to_string());
    }
    if is_broad_or_protected_cleanup_root(&root) {
        return Err("System drive root is blocked. Please choose a user folder such as Downloads, Desktop, Videos, or a project export folder.".to_string());
    }
    Ok(root)
}

pub(super) fn normalize_large_file_mode(mode: Option<&str>) -> String {
    match mode.unwrap_or("video").to_ascii_lowercase().as_str() {
        "all" | "video" | "archives" | "installers" | "documents" | "images" | "audio"
        | "models" => mode.unwrap_or("video").to_ascii_lowercase(),
        _ => "video".to_string(),
    }
}

pub(super) fn cleanup_file_category(extension: &str) -> &'static str {
    match extension {
        "mp4" | "mov" | "mkv" | "avi" | "webm" | "flv" | "m4v" | "wmv" | "ts" | "mpeg" | "mpg" => {
            "video"
        }
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "iso" => "archives",
        "exe" | "msi" | "msix" | "appx" => "installers",
        "pdf" | "ppt" | "pptx" | "doc" | "docx" | "xls" | "xlsx" | "csv" => "documents",
        "psd" | "ai" | "fig" | "raw" | "arw" | "cr2" | "nef" | "tif" | "tiff" | "png" | "jpg"
        | "jpeg" | "webp" | "bmp" => "images",
        "wav" | "flac" | "mp3" | "aac" | "m4a" | "ogg" | "wma" | "alac" => "audio",
        "gguf" | "safetensors" | "pth" | "pt" | "onnx" | "bin" | "ckpt" | "model" => "models",
        _ => "other",
    }
}

pub(super) fn cleanup_mode_allows(mode: &str, category: &str) -> bool {
    mode == "all" || mode == category
}

pub(super) fn is_broad_or_protected_cleanup_root(path: &std::path::Path) -> bool {
    let text = path.to_string_lossy().to_ascii_lowercase();
    #[cfg(target_os = "windows")]
    {
        if let Some(drive) = cleanup_drive_root_letter(path) {
            return drive == 'C';
        }
    }
    let mut normal_components = 0_usize;
    let mut has_root_or_prefix = false;
    for component in path.components() {
        match component {
            std::path::Component::Normal(_) => normal_components += 1,
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                has_root_or_prefix = true
            }
            _ => {}
        }
    }
    if (has_root_or_prefix && normal_components == 0) || text == r"\" || text == "/" {
        return true;
    }
    protected_cleanup_dir_names(path).iter().any(|name| {
        matches!(
            name.as_str(),
            "windows"
                | "program files"
                | "program files (x86)"
                | "programdata"
                | "$recycle.bin"
                | "system volume information"
        )
    })
}

#[cfg(target_os = "windows")]
pub(super) fn cleanup_drive_root_letter(path: &std::path::Path) -> Option<char> {
    let mut components = path.components();
    let drive = match components.next() {
        Some(std::path::Component::Prefix(prefix)) => match prefix.kind() {
            std::path::Prefix::Disk(letter) | std::path::Prefix::VerbatimDisk(letter) => {
                Some((letter as char).to_ascii_uppercase())
            }
            _ => None,
        },
        _ => None,
    }?;
    if !matches!(components.next(), Some(std::path::Component::RootDir)) {
        return None;
    }
    if components.next().is_some() {
        return None;
    }
    Some(drive)
}

pub(super) fn cleanup_display_path(path: &std::path::Path) -> String {
    let text = path.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", rest);
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    text
}

pub(super) fn protected_cleanup_dir_names(path: &std::path::Path) -> Vec<String> {
    path.components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => {
                Some(value.to_string_lossy().to_ascii_lowercase())
            }
            _ => None,
        })
        .collect()
}

pub(super) fn should_skip_cleanup_dir(path: &std::path::Path, root: &std::path::Path) -> bool {
    if path != root && is_broad_or_protected_cleanup_root(path) {
        return true;
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        name.as_str(),
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".cache"
            | "cache"
            | "tmp"
            | "temp"
    )
}

pub(super) fn cleanup_folder_hint(path: &std::path::Path, root: &std::path::Path) -> String {
    let parent = path.parent().unwrap_or(root);
    let relative = parent.strip_prefix(root).unwrap_or(parent);
    let hint = relative.to_string_lossy().trim().to_string();
    if hint.is_empty() || hint == "." {
        "selected folder".to_string()
    } else {
        hint
    }
}

pub(super) fn cleanup_local_risk(path: &std::path::Path, category: &str, size_bytes: u64) -> (String, String) {
    let text = path.to_string_lossy().to_ascii_lowercase();
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if text.contains("\\wechat") || text.contains("\\xwechat") || text.contains("\\wxid_") {
        return (
            "high".to_string(),
            "聊天文件目录，默认不建议自动删除".to_string(),
        );
    }
    if text.contains("\\projects\\")
        || text.contains("\\source\\")
        || text.contains("\\repo")
        || text.contains("\\src\\")
    {
        return (
            "high".to_string(),
            "疑似项目或源码目录，需要人工确认".to_string(),
        );
    }
    if matches!(category, "models") {
        return (
            "high".to_string(),
            "模型或开发资源通常可重新下载但体积大，删除前需要确认".to_string(),
        );
    }
    if matches!(category, "installers" | "archives")
        && (text.contains("\\download") || text.contains("\\downloads") || text.contains("\\下载"))
    {
        return (
            "low".to_string(),
            "下载目录中的安装包或压缩包，通常适合清理".to_string(),
        );
    }
    if category == "video"
        && (file_name.contains("录屏")
            || file_name.contains("record")
            || file_name.contains("capture")
            || file_name.contains("temp"))
    {
        return ("low".to_string(), "疑似录屏、导出或临时视频".to_string());
    }
    if size_bytes >= 1024 * 1024 * 1024 {
        return (
            "medium".to_string(),
            "体积超过 1GB，建议优先人工确认用途".to_string(),
        );
    }
    (
        "medium".to_string(),
        "大文件候选项，需要结合用途确认".to_string(),
    )
}

#[tauri::command]
pub(super) async fn move_files_to_recycle_bin(paths: Vec<String>) -> Result<RecycleBinMoveResult, String> {
    tokio::task::spawn_blocking(move || move_files_to_recycle_bin_blocking(paths))
        .await
        .map_err(|error| format!("Recycle bin worker failed: {}", error))?
}

#[cfg(target_os = "windows")]
pub(super) fn move_files_to_recycle_bin_blocking(paths: Vec<String>) -> Result<RecycleBinMoveResult, String> {
    let mut items = Vec::new();
    let mut moved = 0_usize;
    let mut failed = 0_usize;
    let mut freed_bytes = 0_u64;

    for path in paths.into_iter().take(200) {
        if path.contains('\0') {
            failed += 1;
            items.push(RecycleBinMoveItem {
                path,
                ok: false,
                error: Some("Invalid file path".to_string()),
            });
            continue;
        }
        let canonical = match std::path::PathBuf::from(&path).canonicalize() {
            Ok(path) => path,
            Err(error) => {
                failed += 1;
                items.push(RecycleBinMoveItem {
                    path,
                    ok: false,
                    error: Some(format!("Cannot access file: {}", error)),
                });
                continue;
            }
        };
        let display_path = cleanup_display_path(&canonical);
        if !canonical.is_file() || is_broad_or_protected_cleanup_root(&canonical) {
            failed += 1;
            items.push(RecycleBinMoveItem {
                path: display_path,
                ok: false,
                error: Some(if canonical.is_file() {
                    "Protected file path is not allowed".to_string()
                } else {
                    "Target is not a regular file".to_string()
                }),
            });
            continue;
        }
        let size = std::fs::metadata(&canonical)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        match move_single_file_to_recycle_bin(&canonical) {
            Ok(()) if !canonical.exists() => {
                moved += 1;
                freed_bytes = freed_bytes.saturating_add(size);
                items.push(RecycleBinMoveItem {
                    path: display_path,
                    ok: true,
                    error: None,
                });
            }
            Ok(()) => {
                failed += 1;
                items.push(RecycleBinMoveItem {
                    path: display_path,
                    ok: false,
                    error: Some("Windows reported success, but the file still exists. It may be in use or blocked by permissions.".to_string()),
                });
            }
            Err(error) => {
                failed += 1;
                items.push(RecycleBinMoveItem {
                    path: display_path,
                    ok: false,
                    error: Some(error),
                });
            }
        }
    }

    Ok(RecycleBinMoveResult {
        requested: items.len(),
        moved,
        failed,
        freed_bytes,
        items,
    })
}

#[cfg(target_os = "windows")]
pub(super) fn move_single_file_to_recycle_bin(path: &std::path::Path) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };

    // SHFileOperationW expects a double-null-terminated UTF-16 path list.
    // Use the display path instead of the canonical \\?\ form because the
    // legacy Shell operation is more reliable with normal absolute paths.
    let display_path = cleanup_display_path(path);
    let mut from: Vec<u16> = display_path.encode_utf16().collect();
    from.push(0);
    from.push(0);

    let mut operation = SHFILEOPSTRUCTW::default();
    operation.wFunc = FO_DELETE;
    operation.pFrom = PCWSTR(from.as_ptr());
    operation.fFlags =
        (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_NOERRORUI.0 | FOF_SILENT.0) as u16;

    let result = unsafe { SHFileOperationW(&mut operation) };
    if result != 0 {
        return Err(format!(
            "Windows Recycle Bin API failed with code {}",
            result
        ));
    }
    if operation.fAnyOperationsAborted.as_bool() {
        return Err("Recycle bin operation was cancelled or blocked by Windows".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
#[allow(dead_code)]
pub(super) fn move_files_to_recycle_bin_blocking_powershell_fallback(
    paths: Vec<String>,
) -> Result<RecycleBinMoveResult, String> {
    use std::io::Write;
    use std::os::windows::process::CommandExt;

    let mut entries = Vec::new();
    let mut preflight_items = Vec::new();
    for path in paths.into_iter().take(200) {
        if path.contains('\0') {
            preflight_items.push(RecycleBinMoveItem {
                path,
                ok: false,
                error: Some("Invalid file path".to_string()),
            });
            continue;
        }
        let canonical = match std::path::PathBuf::from(&path).canonicalize() {
            Ok(path) => path,
            Err(error) => {
                preflight_items.push(RecycleBinMoveItem {
                    path,
                    ok: false,
                    error: Some(format!("Cannot access file: {}", error)),
                });
                continue;
            }
        };
        if !canonical.is_file() || is_broad_or_protected_cleanup_root(&canonical) {
            preflight_items.push(RecycleBinMoveItem {
                path: cleanup_display_path(&canonical),
                ok: false,
                error: Some(if canonical.is_file() {
                    "Protected file path is not allowed".to_string()
                } else {
                    "Target is not a regular file".to_string()
                }),
            });
            continue;
        }
        let size = std::fs::metadata(&canonical)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        entries.push(serde_json::json!({
            "path": cleanup_display_path(&canonical),
            "size": size
        }));
    }
    if entries.is_empty() {
        return Ok(RecycleBinMoveResult {
            requested: preflight_items.len(),
            moved: 0,
            failed: preflight_items.len(),
            freed_bytes: 0,
            items: preflight_items,
        });
    }
    let payload = serde_json::to_string(&entries).map_err(|error| error.to_string())?;
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$items = ConvertFrom-Json ([Console]::In.ReadToEnd())
Add-Type -AssemblyName Microsoft.VisualBasic
$ui = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs
$recycle = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
$result = @()
foreach ($item in @($items)) {
  $path = [string]$item.path
  $ok = $false
  $err = $null
    try {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, $ui, $recycle)
      $ok = -not (Test-Path -LiteralPath $path -PathType Leaf)
      if (-not $ok -and -not $err) {
        $err = 'Windows did not move the file to the Recycle Bin. The file may be in use, protected, or blocked by permissions.'
      }
    } else {
      $err = 'File no longer exists'
    }
  } catch {
    $err = $_.Exception.Message
  }
  $result += [ordered]@{ path = $path; ok = [bool]$ok; error = $err; size = [Int64]$item.size }
}
$result | ConvertTo-Json -Depth 4 -Compress
"#;
    let mut child = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            SCRIPT,
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|error| format!("Cannot start recycle bin operation: {}", error))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(payload.as_bytes())
            .map_err(|error| format!("Cannot send recycle bin payload: {}", error))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Recycle bin operation failed: {}", error))?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr)
            .trim()
            .replace(['\r', '\n'], " ");
        return Err(if details.is_empty() {
            "Recycle bin operation failed".to_string()
        } else {
            format!(
                "Recycle bin operation failed: {}",
                details.chars().take(240).collect::<String>()
            )
        });
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Recycle bin operation returned invalid data: {}", error))?;
    let rows = match parsed {
        serde_json::Value::Array(rows) => rows,
        serde_json::Value::Object(_) => vec![parsed],
        _ => Vec::new(),
    };
    let mut moved = 0_usize;
    let mut failed = preflight_items.len();
    let mut freed_bytes = 0_u64;
    let mut items = preflight_items;
    for row in rows {
        let path = row
            .get("path")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let ok = row
            .get("ok")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let size = row
            .get("size")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        let error = row
            .get("error")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        if ok {
            moved += 1;
            freed_bytes = freed_bytes.saturating_add(size);
        } else {
            failed += 1;
        }
        items.push(RecycleBinMoveItem { path, ok, error });
    }
    Ok(RecycleBinMoveResult {
        requested: items.len(),
        moved,
        failed,
        freed_bytes,
        items,
    })
}

#[cfg(not(target_os = "windows"))]
pub(super) fn move_files_to_recycle_bin_blocking(_paths: Vec<String>) -> Result<RecycleBinMoveResult, String> {
    Err("Recycle bin cleanup is currently available on Windows only".to_string())
}

#[cfg(test)]
mod cleanup_large_file_tests {
    use super::*;
    use std::io::Write;

    const MB: u64 = 1024 * 1024;

    fn cleanup_test_dir(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "toolknit-cleanup-{}-{}-{}",
            label,
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&dir).expect("create cleanup test dir");
        dir
    }

    fn make_sparse_file(path: &std::path::Path, size: u64) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create file parent");
        }
        let mut file = std::fs::File::create(path).expect("create sparse file");
        file.write_all(b"toolknit").expect("seed sparse file");
        file.set_len(size).expect("resize sparse file");
    }

    #[test]
    fn cleanup_scan_filters_mode_and_skips_dependency_dirs() {
        let dir = cleanup_test_dir("mode-skip");
        make_sparse_file(&dir.join("screen-record.mp4"), 11 * MB);
        make_sparse_file(&dir.join("installer.zip"), 12 * MB);
        make_sparse_file(&dir.join("node_modules").join("cached-video.mp4"), 12 * MB);

        let result = collect_large_files(
            dir.to_string_lossy().into_owned(),
            Some(10),
            Some("video".to_string()),
        )
        .expect("scan video mode");

        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].name, "screen-record.mp4");
        assert_eq!(result.candidates[0].category, "video");
        assert!(result.skipped_dirs >= 1);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cleanup_scan_all_keeps_supported_large_files_only() {
        let dir = cleanup_test_dir("all-supported");
        make_sparse_file(&dir.join("backup.iso"), 11 * MB);
        make_sparse_file(&dir.join("notes.tmp"), 12 * MB);
        make_sparse_file(&dir.join("report.pdf"), 13 * MB);

        let result = collect_large_files(
            dir.to_string_lossy().into_owned(),
            Some(10),
            Some("all".to_string()),
        )
        .expect("scan all mode");
        let names: Vec<_> = result
            .candidates
            .iter()
            .map(|item| item.name.as_str())
            .collect();

        assert!(names.contains(&"backup.iso"));
        assert!(names.contains(&"report.pdf"));
        assert!(!names.contains(&"notes.tmp"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cleanup_scan_rejects_system_drive_root_only() {
        #[cfg(target_os = "windows")]
        {
            assert!(is_broad_or_protected_cleanup_root(std::path::Path::new(
                "C:\\"
            )));
            assert!(!is_broad_or_protected_cleanup_root(std::path::Path::new(
                "D:\\"
            )));
            let error =
                match collect_large_files("C:\\".to_string(), Some(10), Some("all".to_string())) {
                    Ok(_) => panic!("system drive root should be rejected"),
                    Err(error) => error,
                };
            assert!(error.contains("System drive root is blocked"));
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn cleanup_recycle_bin_moves_temp_file() {
        let dir = cleanup_test_dir("recycle");
        let file_path = dir.join("delete-me.tmp");
        make_sparse_file(&file_path, 1024);

        let result =
            move_files_to_recycle_bin_blocking(vec![file_path.to_string_lossy().into_owned()])
                .expect("move temp file to recycle bin");

        assert_eq!(result.requested, 1);
        assert_eq!(result.moved, 1);
        assert_eq!(result.failed, 0);
        assert!(!file_path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn cleanup_recycle_bin_moves_unicode_video_file() {
        let dir = cleanup_test_dir("recycle-unicode");
        let file_path = dir.join("error [レッドゾーン] (1080p_60fps_H264-128kbit_AAC).mp4");
        make_sparse_file(&file_path, 1024);

        let result =
            move_files_to_recycle_bin_blocking(vec![file_path.to_string_lossy().into_owned()])
                .expect("move unicode video file to recycle bin");

        assert_eq!(result.requested, 1);
        assert_eq!(
            result.moved,
            1,
            "items: {}",
            serde_json::to_string(&result.items).unwrap()
        );
        assert_eq!(result.failed, 0);
        assert!(!file_path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}

