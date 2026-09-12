; electron-builder 自定义 NSIS include
; 关闭 9000 警告:用户要求安装包文件名为 setup.exe,
; NSIS 默认认为该文件名会触发 Windows 兼容性 shim 而把 warning 升级为 error。
!pragma warning disable 9000

; 安装器品牌信息（显示在安装向导每页底部）
BrandingText "本应用由无敌章鱼哥开发 ｜ 更多HiFi资源，加入Q群1023637098获取"

; 欢迎页追加开发者信息（电子安装向导首页正文）
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎使用 安妮播放器融合版V3 安装向导"
  !define MUI_WELCOMEPAGE_TEXT "本应用由无敌章鱼哥开发。$\r$\n$\r$\n更多HiFi资源，加入Q群 1023637098 获取。$\r$\n$\r$\n安装向导将引导你完成 安妮播放器融合版V3 的安装。$\r$\n$\r$\n点击「下一步」继续。"
  !insertmacro MUI_PAGE_WELCOME
!macroend
