const fs = require('fs');
const path = require('path');

const packageJsonPath = path.join(__dirname, '..', 'package.json');

function parseSemver(version) {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`仅支持 x.y.z 版本号，当前为: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function formatSemver({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function bumpVersion(currentVersion, releaseType) {
  const next = parseSemver(currentVersion);

  if (releaseType === 'major') {
    next.major += 1;
    next.minor = 0;
    next.patch = 0;
    return formatSemver(next);
  }

  if (releaseType === 'minor') {
    next.minor += 1;
    next.patch = 0;
    return formatSemver(next);
  }

  if (releaseType === 'patch') {
    next.patch += 1;
    return formatSemver(next);
  }

  parseSemver(releaseType);
  return releaseType;
}

function main() {
  const releaseType = process.argv[2] || 'patch';
  const dryRun = process.argv.includes('--dry-run');
  const content = fs.readFileSync(packageJsonPath, 'utf-8');
  const packageJson = JSON.parse(content);
  const currentVersion = packageJson.version;
  const nextVersion = bumpVersion(currentVersion, releaseType);

  if (currentVersion === nextVersion) {
    console.log(`[version] 版本保持不变: ${currentVersion}`);
    return;
  }

  console.log(`[version] ${currentVersion} -> ${nextVersion}${dryRun ? ' (dry-run)' : ''}`);

  if (dryRun) return;

  packageJson.version = nextVersion;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf-8');
}

main();
