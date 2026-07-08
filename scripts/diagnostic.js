const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

class MonorepoDiagnostic {
  constructor() {
    this.packagesDir = path.join(__dirname, '../packages');
    this.rootDir = path.join(__dirname, '..');
  }

  async diagnose() {
    console.log('🔍 Running monorepo diagnostic...\n');
    
    const checks = [
      () => this.checkProjectStructure(),
      () => this.checkPackageFiles(),
      () => this.checkDependencyIntegrity(),
      () => this.checkBuildArtifacts(),
      () => this.checkScriptAvailability()
    ];

    let allPassed = true;
    
    for (const check of checks) {
      try {
        const passed = await check();
        if (!passed) allPassed = false;
      } catch (error) {
        console.error(`❌ Check failed:`, error.message);
        allPassed = false;
      }
    }

    console.log('\n' + '='.repeat(50));
    if (allPassed) {
      console.log('✅ All diagnostic checks passed!');
    } else {
      console.log('❌ Some diagnostic checks failed. Please review the output above.');
    }
    console.log('='.repeat(50));

    return allPassed;
  }

  checkProjectStructure() {
    console.log('📋 Checking project structure...');
    
    const requiredFiles = [
      'package.json',
      'package-lock.json',
      'packages',
      'scripts/build.js',
      'scripts/dev.js',
      'scripts/clean.js'
    ];

    let allExists = true;
    
    for (const file of requiredFiles) {
      const filePath = path.join(this.rootDir, file);
      if (fs.existsSync(filePath)) {
        console.log(`  ✅ ${file}`);
      } else {
        console.log(`  ❌ ${file} - Missing`);
        allExists = false;
      }
    }

    return allExists;
  }

  checkPackageFiles() {
    console.log('\n📦 Checking package files...');
    
    if (!fs.existsSync(this.packagesDir)) {
      console.log('  ❌ packages directory not found');
      return false;
    }

    const packages = fs.readdirSync(this.packagesDir);
    let allValid = true;

    for (const pkg of packages) {
      const pkgPath = path.join(this.packagesDir, pkg);
      const packageJsonPath = path.join(pkgPath, 'package.json');
      
      if (fs.existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          console.log(`  ✅ ${pkg} - ${packageJson.name}`);
          
          // 检查基本字段
          if (!packageJson.name) {
            console.log(`    ⚠️  Missing name field`);
            allValid = false;
          }
          if (!packageJson.version) {
            console.log(`    ⚠️  Missing version field`);
          }
        } catch (error) {
          console.log(`  ❌ ${pkg} - Invalid package.json: ${error.message}`);
          allValid = false;
        }
      } else {
        console.log(`  ❌ ${pkg} - No package.json found`);
        allValid = false;
      }
    }

    return allValid;
  }

  checkDependencyIntegrity() {
    console.log('\n🔗 Checking dependency integrity...');
    
    try {
      const packages = this.discoverPackages();
      const workspaceNames = new Set(packages.map(pkg => pkg.name));
      let allValid = true;

      for (const pkg of packages) {
        const packageJson = JSON.parse(fs.readFileSync(path.join(pkg.path, 'package.json'), 'utf8'));
        const workspaceDeps = this.extractWorkspaceDependencies(packageJson, workspaceNames);
        
        console.log(`  📦 ${pkg.name}:`);
        
        if (workspaceDeps.length === 0) {
          console.log(`    ℹ️  No workspace dependencies`);
        } else {
          for (const dep of workspaceDeps) {
            const depExists = packages.some(p => p.name === dep);
            if (depExists) {
              console.log(`    ✅ ${dep}`);
            } else {
              console.log(`    ❌ ${dep} - Dependency not found in workspace`);
              allValid = false;
            }
          }
        }
      }

      return allValid;
    } catch (error) {
      console.log(`  ❌ Failed to check dependencies: ${error.message}`);
      return false;
    }
  }

  checkBuildArtifacts() {
    console.log('\n🏗️  Checking build artifacts...');
    
    const packages = this.discoverPackages();
    let allValid = true;

    for (const pkg of packages) {
      const packageJson = JSON.parse(fs.readFileSync(path.join(pkg.path, 'package.json'), 'utf8'));
      
      console.log(`  📦 ${pkg.name}:`);
      
      // 检查主入口文件
      if (packageJson.main) {
        const mainPath = path.join(pkg.path, packageJson.main);
        if (fs.existsSync(mainPath)) {
          console.log(`    ✅ main: ${packageJson.main}`);
        } else {
          console.log(`    ❌ main: ${packageJson.main} - File not found`);
          allValid = false;
        }
      }

      // 检查类型定义文件
      if (packageJson.types) {
        const typesPath = path.join(pkg.path, packageJson.types);
        if (fs.existsSync(typesPath)) {
          console.log(`    ✅ types: ${packageJson.types}`);
        } else {
          console.log(`    ❌ types: ${packageJson.types} - File not found`);
          allValid = false;
        }
      }

      // 检查 dist 目录
      const distPath = path.join(pkg.path, 'dist');
      if (fs.existsSync(distPath)) {
        const distFiles = fs.readdirSync(distPath);
        console.log(`    ✅ dist/ (${distFiles.length} files)`);
      } else if (packageJson.scripts && packageJson.scripts.build) {
        console.log(`    ⚠️  dist/ directory not found (package has build script)`);
      }
    }

    return allValid;
  }

  checkScriptAvailability() {
    console.log('\n🔧 Checking script availability...');
    
    const packages = this.discoverPackages();
    let hasIssues = false;

    for (const pkg of packages) {
      const packageJson = JSON.parse(fs.readFileSync(path.join(pkg.path, 'package.json'), 'utf8'));
      
      console.log(`  📦 ${pkg.name}:`);
      
      const scripts = packageJson.scripts || {};
      const commonScripts = ['build', 'test', 'lint', 'clean'];
      
      for (const script of commonScripts) {
        if (scripts[script]) {
          console.log(`    ✅ ${script}: ${scripts[script]}`);
        } else {
          console.log(`    ℹ️  ${script}: not available`);
        }
      }

      // 检查 watch 相关脚本
      const watchScripts = ['build:watch', 'dev', 'watch'];
      const hasWatchScript = watchScripts.some(script => scripts[script]);
      
      if (hasWatchScript) {
        const watchScript = watchScripts.find(script => scripts[script]);
        console.log(`    ✅ watch: ${watchScript} - ${scripts[watchScript]}`);
      } else {
        console.log(`    ⚠️  watch: no watch scripts available`);
      }
    }

    return !hasIssues;
  }

  discoverPackages() {
    return fs.readdirSync(this.packagesDir)
      .filter(dir => {
        const packagePath = path.join(this.packagesDir, dir, 'package.json');
        return fs.existsSync(packagePath);
      })
      .map(dir => {
        const packagePath = path.join(this.packagesDir, dir, 'package.json');
        const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        return {
          name: packageJson.name,
          path: path.join(this.packagesDir, dir)
        };
      });
  }

  extractWorkspaceDependencies(packageJson, workspaceNames) {
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    return Object.keys(deps).filter(dep => workspaceNames.has(dep));
  }
}

// 执行诊断
if (require.main === module) {
  new MonorepoDiagnostic().diagnose().catch(error => {
    console.error('💥 Diagnostic failed:', error);
    process.exit(1);
  });
}

module.exports = MonorepoDiagnostic;
