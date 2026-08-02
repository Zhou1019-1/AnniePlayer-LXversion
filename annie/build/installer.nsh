; 安妮播放器 NSIS 自定义脚本
; customHeader 宏在 electron-builder 模板 installer.nsi 的顶层插入（位于默认 BrandingText 之后），
; 因此这里的 BrandingText 会覆盖默认值，显示在安装程序每个页面的底部。
; 注意：BrandingText 是编译期指令，只能出现在脚本顶层，不能放进 Section/Function（如 customInstall）。
!macro customHeader
  BrandingText "本应用由无敌章鱼哥开发"
!macroend
