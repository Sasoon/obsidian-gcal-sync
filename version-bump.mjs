import { readFileSync, writeFileSync } from "fs";

// Read the current version from package.json
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const currentVersion = packageJson.version;

// Read the current manifest
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
// Update manifest version
manifest.version = currentVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 4));

// Read the current versions.json
let versions = {};
try {
    versions = JSON.parse(readFileSync("versions.json", "utf8"));
} catch (e) {
    console.log("No versions.json found, creating a new one");
}

// Update versions.json with the current version
versions[currentVersion] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 4));

console.log(`Updated to version ${currentVersion}`); 