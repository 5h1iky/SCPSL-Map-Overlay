; electron-builder 自定义 NSIS 片段
;
; 目的：让安装包自己创建的快捷方式带上 --no-sandbox。
;
; 为什么需要：部分机器（装了 360 主动防御 / 某些 EDR / 输入法与录屏注入软件）上
; Chromium 的沙箱初始化会失败，此时 Electron 会在加载程序代码之前就静默退出 ——
; 用户看到的现象是"双击完全没反应"。带上这个参数即可正常启动。
;
; 为什么用快捷方式参数而不是"启动器脚本"：
;   脚本（.cmd/.ps1）+ WMI/隐藏 PowerShell 那套在安全软件眼里就是可疑行为模板，
;   而一条快捷方式参数不含任何敏感操作，是纯粹的命令行参数。
;
; 本程序只加载自己打包的本地页面（contextIsolation + preload 白名单，无远程内容），
; 关掉渲染进程沙箱的代价可接受。

!macro customInstall
  SetShellVarContext current
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--no-sandbox" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--no-sandbox" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend
