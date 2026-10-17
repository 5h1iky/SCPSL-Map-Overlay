; electron-builder 自定义 NSIS 片段（v0.3.1 重写）
;
; 目的：
;   1) 让安装包自己创建的快捷方式带上 --no-sandbox；
;   2) per-machine 安装时，快捷方式建到「所有用户」的桌面 / 开始菜单（不再是某个账号的桌面）；
;   3) 在开始菜单放一个「卸载」快捷方式 —— 用户不用再去安装目录里找 Uninstall.exe。
;
; 为什么需要 --no-sandbox：部分机器（装了 360 主动防御 / 某些 EDR / 输入法与录屏注入软件）上
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
  ; perMachine = true → 安装器已提权，用 all 才会建到「所有用户」的桌面与开始菜单。
  SetShellVarContext all
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--no-sandbox" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--no-sandbox" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  ; 卸载入口（${UNINSTALL_FILENAME} 由 electron-builder 的 common.nsh 定义）
  CreateShortCut "$SMPROGRAMS\卸载 ${PRODUCT_NAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
!macroend

!macro customUnInstall
  SetShellVarContext all
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\卸载 ${PRODUCT_NAME}.lnk"
!macroend
