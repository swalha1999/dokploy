import { readdirSync } from "node:fs";
import { join } from "node:path";
import { docker } from "@dokploy/server/constants";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { spawnAsync } from "../utils/process/spawnAsync";
// import packageInfo from "../../../package.json";

/** Returns current Dokploy docker image tag or `latest` by default. */
export const getDokployImageTag = () => {
	return process.env.RELEASE_TAG || "latest";
};

/** Returns latest version number and information whether server update is available by comparing current image's digest against digest for provided image tag via Docker hub API. */
export const getUpdateData = async (): Promise<{
	latestVersion: string | null;
	updateAvailable: boolean;
}> => {
	const commandResult = await spawnAsync("docker", [
		"inspect",
		"--format={{index .RepoDigests 0}}",
		getDokployImage(),
	]);

	const currentDigest = commandResult.toString().trim().split("@")[1];

	const url = "https://hub.docker.com/v2/repositories/dokploy/dokploy/tags";
	const response = await fetch(url, {
		method: "GET",
		headers: { "Content-Type": "application/json" },
	});

	const data = (await response.json()) as {
		results: [{ digest: string; name: string }];
	};
	const { results } = data;
	const latestTagDigest = results.find((t) => t.name === "latest")?.digest;

	if (!latestTagDigest) {
		return { latestVersion: null, updateAvailable: false };
	}

	const versionedTag = results.find(
		(t) => t.digest === latestTagDigest && t.name.startsWith("v"),
	);

	if (!versionedTag) {
		return { latestVersion: null, updateAvailable: false };
	}

	const { name: latestVersion, digest } = versionedTag;

	const updateAvailable = digest !== currentDigest;

	return { latestVersion, updateAvailable };
};

export const getDokployImage = () => {
	return `dokploy/dokploy:${getDokployImageTag()}`;
};

export const pullLatestRelease = async () => {
	const stream = await docker.pull(getDokployImage());
	await new Promise((resolve, reject) => {
		docker.modem.followProgress(stream, (err, res) =>
			err ? reject(err) : resolve(res),
		);
	});
};

export const getDokployVersion = () => {
	// return packageInfo.version;
};

interface TreeDataItem {
	id: string;
	name: string;
	type: "file" | "directory";
	children?: TreeDataItem[];
}

export const readDirectory = async (
	dirPath: string,
	serverId?: string,
): Promise<TreeDataItem[]> => {
	if (serverId) {
		const { stdout } = await execAsyncRemote(
			serverId,
			`
process_items() {
    local parent_dir="$1"
    local __resultvar=$2

    local items_json=""
    local first=true
    for item in "$parent_dir"/*; do
        [ -e "$item" ] || continue
        process_item "$item" item_json
        if [ "$first" = true ]; then
            first=false
            items_json="$item_json"
        else
            items_json="$items_json,$item_json"
        fi
    done

    eval $__resultvar="'[$items_json]'"
}

process_item() {
    local item_path="$1"
    local __resultvar=$2

    local item_name=$(basename "$item_path")
    local escaped_name=$(echo "$item_name" | sed 's/"/\\"/g')
    local escaped_path=$(echo "$item_path" | sed 's/"/\\"/g')

    if [ -d "$item_path" ]; then
        # Is directory
        process_items "$item_path" children_json
        local json='{"id":"'"$escaped_path"'","name":"'"$escaped_name"'","type":"directory","children":'"$children_json"'}'
    else
        # Is file
        local json='{"id":"'"$escaped_path"'","name":"'"$escaped_name"'","type":"file"}'
    fi

    eval $__resultvar="'$json'"
}

root_dir=${dirPath}

process_items "$root_dir" json_output

echo "$json_output"
			`,
		);
		const result = JSON.parse(stdout);
		return result;
	}
	const items = readdirSync(dirPath, { withFileTypes: true });

	const stack = [dirPath];
	const result: TreeDataItem[] = [];
	const parentMap: Record<string, TreeDataItem[]> = {};

	while (stack.length > 0) {
		const currentPath = stack.pop();
		if (!currentPath) continue;

		const items = readdirSync(currentPath, { withFileTypes: true });
		const currentDirectoryResult: TreeDataItem[] = [];

		for (const item of items) {
			const fullPath = join(currentPath, item.name);
			if (item.isDirectory()) {
				stack.push(fullPath);
				const directoryItem: TreeDataItem = {
					id: fullPath,
					name: item.name,
					type: "directory",
					children: [],
				};
				currentDirectoryResult.push(directoryItem);
				parentMap[fullPath] = directoryItem.children as TreeDataItem[];
			} else {
				const fileItem: TreeDataItem = {
					id: fullPath,
					name: item.name,
					type: "file",
				};
				currentDirectoryResult.push(fileItem);
			}
		}

		if (parentMap[currentPath]) {
			parentMap[currentPath].push(...currentDirectoryResult);
		} else {
			result.push(...currentDirectoryResult);
		}
	}
	return result;
};
