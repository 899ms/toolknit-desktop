export function imageCropTemplate() {
  return `
    <div class="plasma-bg pdf-merge-v2-bg" id="imageCropPlasmaBg"></div>
    <div class="audio-convert-drop-zone pdf-merge-v2-drop-zone" id="imageCropDropZone"><span class="drop-hint">松手即可载入图片</span></div>
    <header class="pdf-merge-v2-topbar">
      <div class="pdf-merge-v2-topbar-left">
        <button class="settings-v2-back settings-back pdf-merge-v2-back" id="imageCropBack" type="button" title="返回">
          <i data-lucide="arrow-left"></i><span data-i18n="settings.back">返回</span>
        </button>
        <span class="pdf-merge-v2-top-tag">IMAGE TOOLS · CROP STUDIO</span>
      </div>
      <div class="home-v2-top-actions pdf-merge-v2-top-actions">
        <button class="home-v2-nav-link" type="button" data-home-link="website"><i data-lucide="globe-2"></i><span>网页版本</span></button>
        <button class="home-v2-support-top" type="button" data-open-support><i data-lucide="heart"></i><span>支持作者</span></button>
        <div class="home-v2-window-cluster" aria-label="窗口与设置">
          <button class="home-v2-icon-button" id="imageCropV2Settings" type="button" title="设置" aria-label="设置"><i data-lucide="settings"></i></button>
          <div class="home-v2-window-controls" aria-label="窗口控制">
            <button class="home-v2-window-button ctrl-btn" type="button" title="最小化" data-action="minimize"><i data-lucide="minus"></i></button>
            <button class="home-v2-window-button ctrl-btn" type="button" title="最大化" data-action="maximize"><i data-lucide="square"></i></button>
            <button class="home-v2-window-button ctrl-btn" type="button" title="关闭" data-action="close"><i data-lucide="x"></i></button>
          </div>
        </div>
      </div>
    </header>
    <div class="image-crop-v2-body">
      <main class="image-crop-stage-column">
        <div class="image-crop-heading">
          <div>
            <span class="pdf-merge-v2-section-kicker">NON-DESTRUCTIVE · ORIGINAL PIXELS</span>
            <h1>图像裁剪</h1>
            <p id="imageCropFileMeta">精确构图，原始分辨率本地导出</p>
          </div>
          <button class="image-crop-secondary-button" id="imageCropPick" type="button"><i data-lucide="image-plus"></i><span id="imageCropPickLabel">选择图片</span></button>
        </div>
        <section class="image-crop-stage-shell tk-vertical-stripe-surface" id="imageCropStageShell" aria-label="图像裁剪画布">
          <button class="image-crop-empty tk-empty-hero" id="imageCropEmpty" type="button">
            <span class="tk-empty-hero-icon"><i data-lucide="crop"></i></span>
            <span class="tk-empty-hero-kicker">LOCAL IMAGE WORKSPACE</span>
            <strong>载入一张图片开始裁剪</strong>
            <span class="tk-empty-hero-description">支持 JPG、PNG、WebP、BMP 和静态 GIF</span>
            <em><i data-lucide="upload"></i><span>选择图片</span></em>
          </button>
          <canvas class="image-crop-canvas" id="imageCropCanvas" tabindex="0" aria-label="裁剪区域，可拖动或使用方向键微调"></canvas>
          <div class="image-crop-snap-indicator" id="imageCropSnapIndicator" aria-hidden="true"><i data-lucide="magnet"></i><span>中心已吸附</span></div>
          <div class="image-crop-processing" id="imageCropProcessing" aria-live="polite"><span class="image-crop-spinner"></span><strong>正在以原始分辨率导出...</strong></div>
        </section>
        <div class="image-crop-stage-footer">
          <span id="imageCropSelectionSize">等待载入图片</span>
          <span>拖动边角调整 · 拖动内部移动 · Alt 临时关闭吸附</span>
        </div>
      </main>
      <aside class="image-crop-controls" aria-label="裁剪参数">
        <section class="image-crop-control-section image-crop-transform-section">
          <div class="image-crop-section-head"><div><span>TRANSFORM</span><h2>变换</h2></div><div class="image-crop-history">
            <button id="imageCropUndo" type="button" title="撤销" aria-label="撤销" disabled><i data-lucide="undo-2"></i></button>
            <button id="imageCropRedo" type="button" title="重做" aria-label="重做" disabled><i data-lucide="redo-2"></i></button>
          </div></div>
          <div class="image-crop-icon-tools">
            <button type="button" data-crop-transform="rotate-left" title="向左旋转" aria-label="向左旋转"><i data-lucide="rotate-ccw"></i></button>
            <button type="button" data-crop-transform="rotate-right" title="向右旋转" aria-label="向右旋转"><i data-lucide="rotate-cw"></i></button>
            <button type="button" data-crop-transform="flip-horizontal" title="水平翻转" aria-label="水平翻转"><i data-lucide="flip-horizontal-2"></i></button>
            <button type="button" data-crop-transform="flip-vertical" title="垂直翻转" aria-label="垂直翻转"><i data-lucide="flip-vertical-2"></i></button>
            <button type="button" data-crop-transform="reset" title="重置" aria-label="重置"><i data-lucide="refresh-cw"></i></button>
          </div>
        </section>
        <section class="image-crop-control-section">
          <div class="image-crop-section-head"><div><span>ASPECT RATIO</span><h2>裁剪比例</h2></div></div>
          <div class="image-crop-ratio-grid" id="imageCropRatioGrid">
            <button class="active" type="button" data-ratio="free">自由</button><button type="button" data-ratio="original">原图</button>
            <button type="button" data-ratio="1:1">1:1</button><button type="button" data-ratio="4:3">4:3</button>
            <button type="button" data-ratio="3:4">3:4</button><button type="button" data-ratio="3:2">3:2</button>
            <button type="button" data-ratio="2:3">2:3</button><button type="button" data-ratio="16:9">16:9</button>
            <button type="button" data-ratio="9:16">9:16</button><button type="button" data-ratio="21:9">21:9</button>
            <button type="button" data-ratio="custom">自定义</button>
          </div>
          <div class="image-crop-custom-ratio" id="imageCropCustomRatio" hidden>
            <label><span>宽</span><input id="imageCropRatioWidth" type="number" min="1" max="999" value="5"></label>
            <span>:</span>
            <label><span>高</span><input id="imageCropRatioHeight" type="number" min="1" max="999" value="4"></label>
          </div>
        </section>
        <section class="image-crop-control-section image-crop-guide-section">
          <label class="image-crop-field"><span>构图辅助线</span><select id="imageCropGuide">
            <option value="thirds">三分法</option><option value="golden">黄金分割</option><option value="spiral">黄金螺旋</option>
            <option value="crosshair">中心准星</option><option value="diagonals">对角线</option><option value="grid">中心网格</option>
            <option value="safe-area">安全区域</option><option value="none">无</option>
          </select></label>
          <button class="image-crop-spiral-direction" id="imageCropSpiralDirection" type="button" hidden><i data-lucide="rotate-cw"></i><span>旋转螺旋方向</span></button>
          <label class="image-crop-toggle"><span><strong>磁吸居中</strong><small>靠近中心时自动对齐</small></span><input id="imageCropSnap" type="checkbox" checked><i></i></label>
        </section>
        <section class="image-crop-control-section image-crop-export-section">
          <div class="image-crop-section-head"><div><span>EXPORT</span><h2>导出</h2></div></div>
          <div class="image-crop-format" id="imageCropFormat">
            <button class="active" type="button" data-format="png">PNG</button><button type="button" data-format="jpg">JPG</button><button type="button" data-format="webp">WebP</button><button type="button" data-format="bmp">BMP</button>
          </div>
          <label class="image-crop-field"><span>文件名</span><input id="imageCropOutputName" type="text" maxlength="96" placeholder="自动使用原文件名"></label>
          <label class="image-crop-field image-crop-quality" id="imageCropQualityWrap" hidden><span>JPG 质量 <output id="imageCropQualityValue">92</output></span><input id="imageCropQuality" type="range" min="50" max="100" value="92"></label>
          <label class="image-crop-field image-crop-background" id="imageCropBackgroundWrap" hidden><span>透明背景填充</span><input id="imageCropBackground" type="color" value="#ffffff"></label>
          <button class="image-crop-export-button" id="imageCropExport" type="button" disabled><i data-lucide="download"></i><span>导出裁剪图片</span></button>
        </section>
      </aside>
    </div>`;
}

export function imageCropSuccessTemplate() {
  return `<div class="audio-convert-success-overlay" id="imageCropSuccessOverlay">
    <div class="audio-convert-success-dialog">
      <div class="audio-convert-success-icon"><i data-lucide="check"></i></div><h3 class="audio-convert-success-title">裁剪完成</h3>
      <div class="audio-convert-success-meta" id="imageCropSuccessMeta"></div>
      <div class="audio-convert-success-detail">
        <div class="audio-convert-success-row"><span class="audio-convert-success-key">输出规格</span><span class="audio-convert-success-value" id="imageCropSuccessSize"></span></div>
        <div class="audio-convert-success-row"><span class="audio-convert-success-key">保存路径</span><span class="audio-convert-success-value" id="imageCropSuccessPath"></span></div>
      </div>
      <div class="audio-convert-success-actions"><button class="audio-convert-success-btn audio-convert-success-btn-secondary" id="imageCropOpenFolder" type="button">打开文件夹</button><button class="audio-convert-success-btn audio-convert-success-btn-primary" id="imageCropSuccessOk" type="button">继续裁剪</button></div>
    </div>
  </div>`;
}
