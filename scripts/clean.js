const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

class MonorepoCleanManager {
  constructor() {
    this.packagesDir = path.join(__dirname, '../packages');
    this.packages = this.discoverPackages();
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
          path: path.join(this.packagesDir, dir),
          hasCleanScript: !!(packageJson.scripts && packageJson.scripts.clean)
        };
      });
  }

  async cleanPackage(pkg) {
    console.log(`🧹 Cleaning ${pkg.name}...`);
    
    try {
      if (pkg.hasCleanScript) {
        execSync('npm run clean', { 
          cwd: pkg.path, 
          stdio: 'inherit' 
        });
      } else {
        // 默认清理 dist 和 node_modules
        const distPath = path.join(pkg.path, 'dist');
        if (fs.existsSync(distPath)) {
          fs.rmSync(distPath, { recursive: true, force: true });
          console.log(`  ✅ Removed dist directory`);
        }
      }
      
      console.log(`✅ ${pkg.name} cleaned successfully`);
    } catch (error) {
      console.error(`❌ Failed to clean ${pkg.name}:`, error.message);
    }
  }

  async cleanAll() {
    console.log('🧹 Starting monorepo cleanup...');
    console.log('📋 Discovered packages:', this.packages.map(p => p.name).join(', '));

    // 并行清理所有包
    await Promise.all(
      this.packages.map(pkg => this.cleanPackage(pkg))
    );

    // 清理根目录 node_modules
    console.log('🧹 Cleaning root node_modules...');
    const rootNodeModules = path.join(__dirname, '../node_modules');
    if (fs.existsSync(rootNodeModules)) {
      fs.rmSync(rootNodeModules, { recursive: true, force: true });
      console.log('✅ Root node_modules cleaned');
    }

    console.log('🎉 All packages cleaned successfully!');
  }

  async cleanBuildArtifacts() {
    console.log('🧹 Cleaning build artifacts only...');
    
    for (const pkg of this.packages) {
      const distPath = path.join(pkg.path, 'dist');
      if (fs.existsSync(distPath)) {
        fs.rmSync(distPath, { recursive: true, force: true });
        console.log(`✅ Cleaned ${pkg.name}/dist`);
      }
    }

    console.log('✅ All build artifacts cleaned!');
  }
}

// 执行清理
if (require.main === module) {
  const args = process.argv.slice(2);
  const manager = new MonorepoCleanManager();
  
  if (args.includes('--build-only')) {
    manager.cleanBuildArtifacts().catch(error => {
      console.error('💥 Clean failed:', error);
      process.exit(1);
    });
  } else {
    manager.cleanAll().catch(error => {
      console.error('💥 Clean failed:', error);
      process.exit(1);
    });
  }
}

module.exports = MonorepoCleanManager;
