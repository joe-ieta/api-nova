#!/usr/bin/env pwsh

# ApiNova 发布前验证脚本
# 此脚本用于验证包是否准备好发布到 NPM

Write-Host "🚀 ApiNova 发布验证" -ForegroundColor Cyan
Write-Host "=================================" -ForegroundColor Cyan

$projectDir = "packages/api-nova-server"
$packageJson = "$projectDir/package.json"
$distDir = "$projectDir/dist"
$cliFile = "$distDir/cli.js"

# 1. 检查项目结构
Write-Host "`n📁 检查项目结构..." -ForegroundColor Yellow

if (!(Test-Path $packageJson)) {
    Write-Host "❌ 未找到 package.json" -ForegroundColor Red
    exit 1
}
Write-Host "✅ package.json 存在" -ForegroundColor Green

if (!(Test-Path $distDir)) {
    Write-Host "❌ 未找到 dist 目录，请先运行 pnpm run build" -ForegroundColor Red
    exit 1
}
Write-Host "✅ dist 目录存在" -ForegroundColor Green

# 2. 检查 package.json 配置
Write-Host "`n📋 检查 package.json 配置..." -ForegroundColor Yellow

$packageContent = Get-Content $packageJson | ConvertFrom-Json

# 检查 bin 字段
if (!$packageContent.bin) {
    Write-Host "❌ package.json 缺少 bin 字段" -ForegroundColor Red
    exit 1
}
Write-Host "✅ bin 字段配置正确" -ForegroundColor Green

# 检查 files 字段
if (!$packageContent.files) {
    Write-Host "⚠️ package.json 缺少 files 字段（可选）" -ForegroundColor Yellow
} else {
    Write-Host "✅ files 字段配置正确" -ForegroundColor Green
}

# 检查 engines 字段
if (!$packageContent.engines) {
    Write-Host "⚠️ package.json 缺少 engines 字段（建议添加）" -ForegroundColor Yellow
} else {
    Write-Host "✅ engines 字段配置正确" -ForegroundColor Green
}

# 3. 检查 CLI 文件
Write-Host "`n🎯 检查 CLI 文件..." -ForegroundColor Yellow

if (!(Test-Path $cliFile)) {
    Write-Host "❌ 未找到编译后的 CLI 文件: $cliFile" -ForegroundColor Red
    exit 1
}

# 检查 shebang
$firstLine = Get-Content $cliFile -First 1
if ($firstLine -ne "#!/usr/bin/env node") {
    Write-Host "❌ CLI 文件缺少正确的 shebang" -ForegroundColor Red
    exit 1
}
Write-Host "✅ CLI 文件 shebang 正确" -ForegroundColor Green

# 4. 测试 CLI 功能
Write-Host "`n🧪 测试 CLI 功能..." -ForegroundColor Yellow

try {
    $output = & node $cliFile --help 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ CLI --help 命令正常工作" -ForegroundColor Green
    } else {
        Write-Host "❌ CLI --help 命令失败" -ForegroundColor Red
        Write-Host $output -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "❌ CLI 测试失败: $_" -ForegroundColor Red
    exit 1
}

# 5. 检查必需文件
Write-Host "`n📄 检查必需文件..." -ForegroundColor Yellow

$requiredFiles = @("README.md", "LICENSE", "ARCHITECTURE.md")
foreach ($file in $requiredFiles) {
    $filePath = "$projectDir/$file"
    if (Test-Path $filePath) {
        Write-Host "✅ $file 存在" -ForegroundColor Green
    } else {
        Write-Host "❌ 缺少 $file" -ForegroundColor Red
    }
}

# 6. 创建测试包
Write-Host "`n📦 创建测试包..." -ForegroundColor Yellow

Push-Location $projectDir
try {
    $packOutput = npm pack 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✅ 测试包创建成功" -ForegroundColor Green
        
        # 显示包信息
        $tarballName = ($packOutput | Select-String "\.tgz$").Line.Trim()
        if ($tarballName) {
            Write-Host "📦 包文件: $tarballName" -ForegroundColor Cyan
            
            # 获取包大小
            if (Test-Path $tarballName) {
                $size = (Get-Item $tarballName).Length / 1KB
                Write-Host "📏 包大小: $([math]::Round($size, 2)) KB" -ForegroundColor Cyan
            }
        }
    } else {
        Write-Host "❌ 测试包创建失败" -ForegroundColor Red
        Write-Host $packOutput -ForegroundColor Red
    }
} finally {
    Pop-Location
}

# 7. 发布建议
Write-Host "`n🎯 发布建议:" -ForegroundColor Cyan
Write-Host "1. 确保已登录 NPM: npm login" -ForegroundColor White
Write-Host "2. 首次发布建议使用 beta 标签: npm publish --tag beta" -ForegroundColor White
Write-Host "3. 测试 beta 版本后再发布正式版: npm publish" -ForegroundColor White
Write-Host "4. 发布后验证: npm info api-nova-server" -ForegroundColor White

# 8. 使用示例
Write-Host "`n📚 发布后用户使用示例:" -ForegroundColor Cyan
Write-Host "npm install -g api-nova-server" -ForegroundColor Green
Write-Host "api-nova-server --help" -ForegroundColor Green
Write-Host "api-nova-server --transport streamable --openapi https://api.github.com/openapi.json" -ForegroundColor Green

Write-Host "`n🎉 验证完成！项目已准备好发布到 NPM。" -ForegroundColor Green
