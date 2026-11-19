# 雷电模拟器 14 与 ADB 配置

用户设备基线：LDPlayer 14。官方文档说明 ldconsole 支持雷电 14；但 ADB serial 必须现场查询，不能仅按端口公式猜测。

## 1. 找到 ADB

优先使用雷电安装目录自带的 `adb.exe`。雷电版本/安装路径不同，不能假设固定路径。

PowerShell 示例：

```powershell
# 将路径替换为你电脑上的实际路径
$ADB = "C:\LDPlayer\LDPlayer9\adb.exe"
& $ADB devices -l
```

若使用系统 PATH 中的 adb：

```powershell
adb devices -l
```

必须从输出中复制实际 serial，不要盲目假设一定是 127.0.0.1:5555 或 emulator-5554。

## 2. 建立设备到 Windows 主机的反向端口转发

Android ADB 提供的命令格式（在你的雷电14环境仍需现场验证）：

```powershell
adb -s <serial> reverse tcp:18765 tcp:18765
```

示例（serial 仅为示例，按 `adb devices -l` 实际输出替换）：

```powershell
& $ADB -s 127.0.0.1:5555 reverse tcp:18765 tcp:18765
```

验证：

```powershell
& $ADB -s <serial> reverse --list
```

这会让 Android/Via 访问 `http://127.0.0.1:18765` 时，通过 ADB 转发到 Windows 的 127.0.0.1:18765。

注意：
- 雷电官方 ADB 指南没有保证你的具体雷电14构建一定支持 `adb reverse`；本项目必须现场执行并检查结果。
- 如 reverse 不支持，先不要改成向公网暴露服务；应由 Windows Bridge 开发者评估雷电专用网络映射、受限的局域网地址或其他安全替代方案。
- 多开实例应逐个使用 `-s <serial>` 设置，避免转发到错误实例。
- Bridge 应只绑定 Windows `127.0.0.1`，不要绑定 `0.0.0.0`。

## 3. 查看 Via 与 Android WebView

Via 官方 README 说明 Via 使用 Android 平台内置 WebView。可在 Via 设置 → 关于页面查看 WebView 调试信息（点击 Via 标志可显示详细信息，具体入口随版本变化）。

建议记录：
- Via 版本号；
- Android 版本；
- Android System WebView / Chromium 版本；
- 雷电版本；
- `adb devices -l` 中的设备 serial。

## 4. ADB 诊断命令

```powershell
& $ADB devices -l
& $ADB -s <serial> shell getprop ro.build.version.release
& $ADB -s <serial> shell pm list packages | Select-String "via"
& $ADB -s <serial> reverse --list
```

可用 `adb push` 将脚本放入共享目录（具体目录取决于模拟器 Android 版本和共享目录配置）：

```powershell
& $ADB -s <serial> push .\DSH-GPT-Bridge.user.js /sdcard/Download/
```

随后在 Via 文件管理/下载目录中打开该脚本。
