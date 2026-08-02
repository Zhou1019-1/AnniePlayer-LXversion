; electron-builder 自定义 NSIS include
; 关闭 9000 警告:用户要求安装包文件名为 setup.exe,
; NSIS 默认认为该文件名会触发 Windows 兼容性 shim 而把 warning 升级为 error。
!pragma warning disable 9000
