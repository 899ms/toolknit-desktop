// Extracted static markup; runtime values are rendered separately through escaped boundaries.

export function hardwareOverviewTemplate() {
  return `
      <div class="plasma-bg pdf-merge-v2-bg" id="hardwareOverviewPlasmaBg"></div>
      <header class="pdf-merge-v2-topbar">
        <div class="settings-v2-topbar-left pdf-merge-v2-topbar-left">
          <button class="settings-v2-back settings-back pdf-merge-v2-back" id="hardwareOverviewBack" type="button" data-i18n-title="settings.back" title="返回首页">
            <i data-lucide="arrow-left"></i>
            <span data-i18n="settings.back">返回首页</span>
          </button>
          <span class="pdf-merge-v2-top-tag">SYSTEM · TOOL PAGE 2.3</span>
        </div>
        <div class="home-v2-top-actions pdf-merge-v2-top-actions">
          <button class="home-v2-nav-link" type="button" data-home-link="website">
            <i data-lucide="globe-2"></i>
            <span>网页版本</span>
          </button>
          <button class="home-v2-support-top" type="button" data-open-support>
            <i data-lucide="heart"></i>
            <span>支持作者</span>
          </button>
          <div class="home-v2-window-cluster" aria-label="窗口与设置">
            <button class="home-v2-icon-button" id="hardwareOverviewV2Settings" type="button" data-i18n-title="nav.settings" title="设置" aria-label="设置">
              <i data-lucide="settings"></i>
            </button>
            <div class="home-v2-window-controls" aria-label="窗口控制">
              <button class="home-v2-window-button ctrl-btn" type="button" data-i18n-title="common.minimize" title="最小化" data-action="minimize"><i data-lucide="minus"></i></button>
              <button class="home-v2-window-button ctrl-btn" type="button" data-i18n-title="common.maximize" title="最大化" data-action="maximize"><i data-lucide="square"></i></button>
              <button class="home-v2-window-button ctrl-btn" type="button" data-i18n-title="common.close" title="关闭" data-action="close"><i data-lucide="x"></i></button>
            </div>
          </div>
        </div>
      </header>
      <div class="audio-convert-body pdf-merge-v2-body hardware-v2-body hardware-overview-body">
        <aside class="pdf-merge-v2-poster hardware-v2-poster hardware-overview-hero" aria-label="整机概览说明">
          <div class="pdf-merge-v2-poster-kicker" data-i18n="home.hardwareOverviewPage.heroLabel">System Overview</div>
          <h1 class="pdf-merge-v2-title" data-i18n="home.hardwareOverviewPage.title">整机概览</h1>
          <p class="pdf-merge-v2-subtitle" data-i18n="home.hardwareOverviewPage.subtitle">本地读取系统与核心硬件信息，不上传任何数据。</p>
          <div class="pdf-merge-v2-poster-note">
            <span>READ ONLY</span>
            <strong>整机状态、本机安全能力与核心硬件信息只读展示。</strong>
          </div>
          <div class="pdf-merge-v2-steps" aria-label="硬件信息读取流程">
            <div class="pdf-merge-v2-step is-active"><span>01</span><div><strong>本机读取</strong><p>调用桌面端安全接口读取系统公开信息。</p></div></div>
            <div class="pdf-merge-v2-step"><span>02</span><div><strong>分类整理</strong><p>按核心参数、设备表格和状态提示分组。</p></div></div>
            <div class="pdf-merge-v2-step"><span>03</span><div><strong>人工判断</strong><p>缺失字段不会猜测，避免误导硬件结论。</p></div></div>
            <div class="pdf-merge-v2-step"><span>04</span><div><strong>刷新更新</strong><p>点击刷新可重新读取当前状态。</p></div></div>
          </div>
        </aside>
        <main class="pdf-merge-v2-workspace hardware-v2-workspace">
          <section class="hardware-v2-panel">
            <div class="hardware-v2-panel-head">
              <div>
                <span class="pdf-merge-v2-section-kicker">LOCAL INSPECTOR</span>
                <h2 data-i18n="home.hardwareOverviewPage.title">整机概览</h2>
              </div>
              <div class="hardware-overview-refresh-row hardware-v2-refresh-row">
                <button class="hardware-overview-refresh hardware-v2-refresh" id="hardwareOverviewRefresh" type="button" data-i18n-title="home.hardwareOverviewPage.refresh" data-i18n-aria-label="home.hardwareOverviewPage.refresh">
                  <i data-lucide="refresh-cw"></i>
                </button>
                <span id="hardwareOverviewUpdatedAt" aria-live="polite"></span>
              </div>
            </div>
            <div class="hardware-v2-content hardware-overview-content" id="hardwareOverviewContent" aria-live="polite"></div>
          </section>
        </main>
      </div>
    `;
}

export function hardwareMainboardTemplate() {
  return `
      <div class="plasma-bg pdf-merge-v2-bg" id="hardwareMainboardPlasmaBg"></div>
      <header class="pdf-merge-v2-topbar">
        <div class="settings-v2-topbar-left pdf-merge-v2-topbar-left">
          <button class="settings-v2-back settings-back pdf-merge-v2-back" id="hardwareMainboardBack" type="button" data-i18n-title="settings.back" title="返回首页">
            <i data-lucide="arrow-left"></i>
            <span data-i18n="settings.back">返回首页</span>
          </button>
          <span class="pdf-merge-v2-top-tag">BOARD · TOOL PAGE 2.3</span>
        </div>
        <div class="home-v2-top-actions pdf-merge-v2-top-actions">
          <button class="home-v2-nav-link" type="button" data-home-link="website">
            <i data-lucide="globe-2"></i>
            <span>网页版本</span>
          </button>
          <button class="home-v2-support-top" type="button" data-open-support>
            <i data-lucide="heart"></i>
            <span>支持作者</span>
          </button>
          <div class="home-v2-window-cluster" aria-label="窗口与设置">
            <button class="home-v2-icon-button" id="hardwareMainboardV2Settings" type="button" data-i18n-title="nav.settings" title="设置" aria-label="设置">
              <i data-lucide="settings"></i>
            </button>
            <div class="home-v2-window-controls" aria-label="窗口控制">
              <button class="home-v2-window-button ctrl-btn" type="button" data-i18n-title="common.minimize" title="最小化" data-action="minimize"><i data-lucide="minus"></i></button>
              <button class="home-v2-window-button ctrl-btn" type="button" data-i18n-title="common.maximize" title="最大化" data-action="maximize"><i data-lucide="square"></i></button>
              <button class="home-v2-window-button ctrl-btn" type="button" data-i18n-title="common.close" title="关闭" data-action="close"><i data-lucide="x"></i></button>
            </div>
          </div>
        </div>
      </header>
      <div class="audio-convert-body pdf-merge-v2-body hardware-v2-body hardware-mainboard-body">
        <aside class="pdf-merge-v2-poster hardware-v2-poster hardware-mainboard-hero" aria-label="主板与固件说明">
          <div class="pdf-merge-v2-poster-kicker" data-i18n="home.mainboardPage.heroLabel">Mainboard & Firmware</div>
          <h1 class="pdf-merge-v2-title" data-i18n="home.mainboardPage.title">主板与固件</h1>
          <p class="pdf-merge-v2-subtitle" data-i18n="home.mainboardPage.subtitle">本地读取主板、BIOS/UEFI、启动安全能力与 PCI 设备信息。</p>
          <div class="pdf-merge-v2-poster-note">
            <span>READ ONLY</span>
            <strong>固件、安全启动、TPM 与 PCI 设备只做只读展示。</strong>
          </div>
          <div class="pdf-merge-v2-steps" aria-label="硬件信息读取流程">
            <div class="pdf-merge-v2-step is-active"><span>01</span><div><strong>本机读取</strong><p>调用桌面端安全接口读取系统公开信息。</p></div></div>
            <div class="pdf-merge-v2-step"><span>02</span><div><strong>分类整理</strong><p>按核心参数、设备表格和状态提示分组。</p></div></div>
            <div class="pdf-merge-v2-step"><span>03</span><div><strong>人工判断</strong><p>缺失字段不会猜测，避免误导硬件结论。</p></div></div>
            <div class="pdf-merge-v2-step"><span>04</span><div><strong>刷新更新</strong><p>点击刷新可重新读取当前状态。</p></div></div>
          </div>
        </aside>
        <main class="pdf-merge-v2-workspace hardware-v2-workspace">
          <section class="hardware-v2-panel">
            <div class="hardware-v2-panel-head">
              <div>
                <span class="pdf-merge-v2-section-kicker">LOCAL INSPECTOR</span>
                <h2 data-i18n="home.mainboardPage.title">主板与固件</h2>
              </div>
              <div class="hardware-overview-refresh-row hardware-v2-refresh-row">
                <button class="hardware-overview-refresh hardware-v2-refresh" id="hardwareMainboardRefresh" type="button" data-i18n-title="home.mainboardPage.refresh" data-i18n-aria-label="home.mainboardPage.refresh">
                  <i data-lucide="refresh-cw"></i>
                </button>
                <span id="hardwareMainboardUpdatedAt" aria-live="polite"></span>
              </div>
            </div>
            <div class="hardware-v2-content hardware-mainboard-content" id="hardwareMainboardContent" aria-live="polite"></div>
          </section>
        </main>
      </div>
    `;
}

export function hardwareStorageTemplate() {
  return `
      <div class="plasma-bg pdf-merge-v2-bg" id="hardwareStoragePlasmaBg"></div>
      <header class="pdf-merge-v2-topbar">
        <div class="settings-v2-topbar-left pdf-merge-v2-topbar-left">
          <button class="settings-v2-back settings-back pdf-merge-v2-back" id="hardwareStorageBack" type="button" data-i18n-title="settings.back" title="返回首页">
            <i data-lucide="arrow-left"></i>
            <span data-i18n="settings.back">返回首页</span>
          </button>
          <span class="pdf-merge-v2-top-tag">STORAGE · TOOL PAGE 2.3</span>
        </div>
        <div class="home-v2-top-actions pdf-merge-v2-top-actions">
          <button class="home-v2-nav-link" type="button" data-home-link="website">
            <i data-lucide="globe-2"></i>
            <span>网页版本</span>
          </button>
          <button class="home-v2-support-top" type="button" data-open-support>
            <i data-lucide="heart"></i>
            <span>支持作者</span>
          </button>
          <div class="home-v2-window-cluster" aria-label="窗口与设置">
            <button class="home-v2-icon-button" id="hardwareStorageV2Settings" type="button" data-i18n-title="nav.settings" title="设置" aria-label="设置">
              <i data-lucide="settings"></i>
            </button>
            <div class="home-v2-window-controls" aria-label="窗口控制">
              <button class="home-v2-window-button ctrl-btn" type="button" data-i18n-title="common.minimize" title="最小化" data-action="minimize"><i data-lucide="minus"></i></button>
              <button class="home-v2-window-button ctrl-btn" type="button" data-i18n-title="common.maximize" title="最大化" data-action="maximize"><i data-lucide="square"></i></button>
              <button class="home-v2-window-button ctrl-btn" type="button" data-i18n-title="common.close" title="关闭" data-action="close"><i data-lucide="x"></i></button>
            </div>
          </div>
        </div>
      </header>
      <div class="audio-convert-body pdf-merge-v2-body hardware-v2-body hardware-storage-body">
        <aside class="pdf-merge-v2-poster hardware-v2-poster hardware-storage-hero" aria-label="磁盘与健康说明">
          <div class="pdf-merge-v2-poster-kicker" data-i18n="home.storagePage.heroLabel">Storage & Health</div>
          <h1 class="pdf-merge-v2-title" data-i18n="home.storagePage.title">磁盘与健康</h1>
          <p class="pdf-merge-v2-subtitle" data-i18n="home.storagePage.subtitle">本地读取物理磁盘、卷空间与系统实际提供的可靠性计数器。</p>
          <div class="pdf-merge-v2-poster-note">
            <span>READ ONLY</span>
            <strong>磁盘容量、分区与可靠性字段只读取系统暴露信息。</strong>
          </div>
          <div class="pdf-merge-v2-steps" aria-label="硬件信息读取流程">
            <div class="pdf-merge-v2-step is-active"><span>01</span><div><strong>本机读取</strong><p>调用桌面端安全接口读取系统公开信息。</p></div></div>
            <div class="pdf-merge-v2-step"><span>02</span><div><strong>分类整理</strong><p>按核心参数、设备表格和状态提示分组。</p></div></div>
            <div class="pdf-merge-v2-step"><span>03</span><div><strong>人工判断</strong><p>缺失字段不会猜测，避免误导硬件结论。</p></div></div>
            <div class="pdf-merge-v2-step"><span>04</span><div><strong>刷新更新</strong><p>点击刷新可重新读取当前状态。</p></div></div>
          </div>
        </aside>
        <main class="pdf-merge-v2-workspace hardware-v2-workspace">
          <section class="hardware-v2-panel">
            <div class="hardware-v2-panel-head">
              <div>
                <span class="pdf-merge-v2-section-kicker">LOCAL INSPECTOR</span>
                <h2 data-i18n="home.storagePage.title">磁盘与健康</h2>
              </div>
              <div class="hardware-overview-refresh-row hardware-v2-refresh-row">
                <button class="hardware-overview-refresh hardware-v2-refresh" id="hardwareStorageRefresh" type="button" data-i18n-title="home.storagePage.refresh" data-i18n-aria-label="home.storagePage.refresh">
                  <i data-lucide="refresh-cw"></i>
                </button>
                <span id="hardwareStorageUpdatedAt" aria-live="polite"></span>
              </div>
            </div>
            <div class="hardware-v2-content hardware-storage-content" id="hardwareStorageContent" aria-live="polite"></div>
          </section>
        </main>
      </div>
    `;
}

export function hardwareNetworkDevicesTemplate() {
  return `
      <div class="plasma-bg pdf-merge-v2-bg" id="hardwareNetworkDevicesPlasmaBg"></div>
      <header class="pdf-merge-v2-topbar">
        <div class="settings-v2-topbar-left pdf-merge-v2-topbar-left">
          <button class="settings-v2-back settings-back pdf-merge-v2-back" id="hardwareNetworkDevicesBack" type="button" data-i18n-title="settings.back" title="返回首页">
            <i data-lucide="arrow-left"></i>
            <span data-i18n="settings.back">返回首页</span>
          </button>
          <span class="pdf-merge-v2-top-tag">DEVICES · TOOL PAGE 2.3</span>
        </div>
        <div class="home-v2-top-actions pdf-merge-v2-top-actions">
          <button class="home-v2-nav-link" type="button" data-home-link="website">
            <i data-lucide="globe-2"></i>
            <span>网页版本</span>
          </button>
          <button class="home-v2-support-top" type="button" data-open-support>
            <i data-lucide="heart"></i>
            <span>支持作者</span>
          </button>
          <div class="home-v2-window-cluster" aria-label="窗口与设置">
            <button class="home-v2-icon-button" id="hardwareNetworkDevicesV2Settings" type="button" data-i18n-title="nav.settings" title="设置" aria-label="设置">
              <i data-lucide="settings"></i>
            </button>
            <div class="home-v2-window-controls" aria-label="窗口控制">
              <button class="home-v2-window-button ctrl-btn" type="button" data-i18n-title="common.minimize" title="最小化" data-action="minimize"><i data-lucide="minus"></i></button>
              <button class="home-v2-window-button ctrl-btn" type="button" data-i18n-title="common.maximize" title="最大化" data-action="maximize"><i data-lucide="square"></i></button>
              <button class="home-v2-window-button ctrl-btn" type="button" data-i18n-title="common.close" title="关闭" data-action="close"><i data-lucide="x"></i></button>
            </div>
          </div>
        </div>
      </header>
      <div class="audio-convert-body pdf-merge-v2-body hardware-v2-body hardware-network-devices-body">
        <aside class="pdf-merge-v2-poster hardware-v2-poster hardware-network-devices-hero" aria-label="网络与设备说明">
          <div class="pdf-merge-v2-poster-kicker" data-i18n="home.networkDevicesPage.heroLabel">Network & Devices</div>
          <h1 class="pdf-merge-v2-title" data-i18n="home.networkDevicesPage.title">网络与设备</h1>
          <p class="pdf-merge-v2-subtitle" data-i18n="home.networkDevicesPage.subtitle">本地读取网卡、蓝牙、音频、USB 与摄像头设备状态，不显示网络地址。</p>
          <div class="pdf-merge-v2-poster-note">
            <span>READ ONLY</span>
            <strong>设备清单按类别整理，不显示 IP、MAC 等网络标识。</strong>
          </div>
          <div class="pdf-merge-v2-steps" aria-label="硬件信息读取流程">
            <div class="pdf-merge-v2-step is-active"><span>01</span><div><strong>本机读取</strong><p>调用桌面端安全接口读取系统公开信息。</p></div></div>
            <div class="pdf-merge-v2-step"><span>02</span><div><strong>分类整理</strong><p>按核心参数、设备表格和状态提示分组。</p></div></div>
            <div class="pdf-merge-v2-step"><span>03</span><div><strong>人工判断</strong><p>缺失字段不会猜测，避免误导硬件结论。</p></div></div>
            <div class="pdf-merge-v2-step"><span>04</span><div><strong>刷新更新</strong><p>点击刷新可重新读取当前状态。</p></div></div>
          </div>
        </aside>
        <main class="pdf-merge-v2-workspace hardware-v2-workspace">
          <section class="hardware-v2-panel">
            <div class="hardware-v2-panel-head">
              <div>
                <span class="pdf-merge-v2-section-kicker">LOCAL INSPECTOR</span>
                <h2 data-i18n="home.networkDevicesPage.title">网络与设备</h2>
              </div>
              <div class="hardware-overview-refresh-row hardware-v2-refresh-row">
                <button class="hardware-overview-refresh hardware-v2-refresh" id="hardwareNetworkDevicesRefresh" type="button" data-i18n-title="home.networkDevicesPage.refresh" data-i18n-aria-label="home.networkDevicesPage.refresh">
                  <i data-lucide="refresh-cw"></i>
                </button>
                <span id="hardwareNetworkDevicesUpdatedAt" aria-live="polite"></span>
              </div>
            </div>
            <div class="hardware-v2-content hardware-network-devices-content" id="hardwareNetworkDevicesContent" aria-live="polite"></div>
          </section>
        </main>
      </div>
    `;
}
