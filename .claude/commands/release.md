# Release

Bump the version and create a new GitHub release for the Obsidian plugin.

## Steps

1. Run `npm run version` to bump the version in manifest.json and versions.json
2. Get the new version number from manifest.json
3. Commit the version bump with message "bump version to X.X.X"
4. Create a git tag matching the version
5. Push both the commit and tag to origin
6. Report the release URL to the user

## Important

- The GitHub Actions workflow will automatically build and publish the release when the tag is pushed
- Always verify the build passes locally before releasing (`npm run build`)
