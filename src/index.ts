#!/usr/bin/env node
import { Command } from "commander";
import fs from "fs";
import path from "path";
import { version } from "../package.json";
import os from "os";

type Options = {
  ext: boolean;
  name: boolean;
  ignoreDotfiles: boolean;
};

// Define mappings for file types to folder names
const FILE_TYPE_MAP: Record<string, string> = {
  ".png": "images-png",
  ".jpg": "images-jpg",
  ".jpeg": "images-jpeg",
  ".mp4": "videos-mp4",
  ".avi": "videos-avi",
  ".pdf": "documents-pdf",
};

class FilePathResolver {
  private existingFiles = new Set<string>();

  async getUniquePath(basePath: string, fileName: string): Promise<string> {
    let newPath = path.join(basePath, fileName);
    let counter = 1;

    while (this.existingFiles.has(newPath)) {
      const { name, ext } = path.parse(fileName);
      newPath = path.join(basePath, `${name}(${counter})${ext}`);
      counter++;
    }

    this.existingFiles.add(newPath);
    return newPath;
  }
}

const program = new Command();

program
  .version(version)
  .argument("[directory]", "Directory to tidy up", ".")
  .description("Organize files in a directory based on their extensions")
  .option("--ext", "Use the file extensions as folder names")
  .option("--name", "Group files by starting name")
  .option("--ignore-dotfiles", "Ignore dotfiles")
  .action(async (inputDir: string, options: Options) => {
    const dirPath = path.resolve(inputDir);
    try {
      if (options.ext && options.name) {
        console.error("Only one of --ext or --name can be used at a time");
        process.exit(1);
      }

      const dirStat = await fs.promises.stat(dirPath);
      if (!dirStat.isDirectory()) {
        console.error(`The provided path is not a directory: ${dirPath}`);
        process.exit(1);
      }

      await organizeFiles(dirPath, options);
    } catch (error: any) {
      console.error("An error occurred:", error.message);
      process.exit(1);
    }
  });

program.parse(process.argv);

/**
 * Check if a file is a dotfile (starts with a dot)
 * @param fileName - The name of the file to check
 * @returns True if the file is a dotfile, false otherwise
 */
function isDotFile(fileName: string): boolean {
  return fileName.startsWith(".");
}

/**
 * Get all file types present in a directory.
 * @param dirPath - The path to the directory.
 * @returns A record where keys are file extensions and values are file paths.
 */
async function getFileGroups(
  dirPath: string,
  options: Options
): Promise<Record<string, string[]>> {
  const groups: Record<string, string[]> = {};
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (options.ignoreDotfiles && isDotFile(entry.name)) continue;

    const filePath = path.join(dirPath, entry.name);
    const key = options.name
      ? path.parse(entry.name).name.slice(0, 10)
      : path.extname(entry.name).toLowerCase();

    groups[key] = groups[key] || [];
    groups[key].push(filePath);
  }

  return groups;
}

/**
 * Ensures that all necessary folders exist for organizing files based on their
 * extensions or names. Creates folders if they do not exist and maps each group
 * key to its corresponding folder path.
 *
 * @param groups - A record where keys are file extensions or names, and values
 * are arrays of file paths belonging to those groups.
 * @param dirPath - The base directory path where folders will be created.
 * @param options - Options to determine whether to group by extension or name,
 * and to ignore dotfiles.
 * @returns A map where keys are group identifiers and values are paths to the
 * corresponding folders.
 */
async function ensureFolders(
  groups: Record<string, string[]>,
  dirPath: string,
  options: Options
): Promise<Map<string, string>> {
  const folderMap = new Map<string, string>();

  for (const key of Object.keys(groups)) {
    const folderName = options.ext
      ? key.replace(".", "")
      : FILE_TYPE_MAP[key] || `others-${key.replace(".", "")}`;

    const folderPath = path.join(dirPath, folderName);
    try {
      await fs.promises.mkdir(folderPath, { recursive: true });
    } catch (e) {
      // Folder might already exist, ignore error
    }
    folderMap.set(key, folderPath);
  }

  return folderMap;
}

/**
 * Moves files to a target directory in chunks to prevent overwhelming the system.
 *
 * @param files - An array of file paths that need to be moved.
 * @param targetDir - The directory where the files should be moved to.
 * @param resolver - A utility to resolve and ensure unique file paths in the target directory.
 * @returns A promise that resolves to the number of files successfully moved.
 */
async function moveFilesInChunks(
  files: string[],
  targetDir: string,
  resolver: FilePathResolver
): Promise<number> {
  const chunkSize = 100;
  let processed = 0;

  for (let i = 0; i < files.length; i += chunkSize) {
    const chunk = files.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async (filePath) => {
        const fileName = path.basename(filePath);
        const newPath = await resolver.getUniquePath(targetDir, fileName);
        await fs.promises.rename(filePath, newPath);
        processed++;
      })
    );
  }

  return processed;
}

/**
 * Processes file groups in parallel by dividing the work into chunks and
 * running each chunk in a separate CPU core. The number of chunks is
 * determined by the number of CPUs available on the system.
 *
 * @param groups - A record where keys are file extensions or names, and values
 * are arrays of file paths.
 * @param folderMap - A map where keys are group identifiers and values are paths
 * to the corresponding folders.
 * @returns A promise that resolves to a record where keys are group identifiers
 * and values are the number of files successfully moved.
 */
async function processInParallel(
  groups: Record<string, string[]>,
  folderMap: Map<string, string>
): Promise<Record<string, number>> {
  const results: Record<string, number> = {};
  const resolver = new FilePathResolver();
  const cpus = os.cpus().length;

  // Create chunks of work
  const entries = Object.entries(groups);
  const chunkSize = Math.max(1, Math.ceil(entries.length / cpus));
  const chunks = Array.from(
    { length: Math.ceil(entries.length / chunkSize) },
    (_, i) => entries.slice(i * chunkSize, (i + 1) * chunkSize)
  );

  await Promise.all(
    chunks.map(async (chunk) => {
      for (const [key, files] of chunk) {
        const targetDir = folderMap.get(key)!;
        results[key] = await moveFilesInChunks(files, targetDir, resolver);
      }
    })
  );

  return results;
}

/**
 * Organize files into folders based on their extensions and provide detailed output.
 * @param dirPath - The directory path to organize.
 */
async function organizeFiles(dirPath: string, options: Options): Promise<void> {
  console.time("Organization completed in");

  // Get all files grouped by extension or name
  const groups = await getFileGroups(dirPath, options);

  // Ensure all necessary folders exist
  const folderMap = await ensureFolders(groups, dirPath, options);

  // Process files in parallel
  const results = await processInParallel(groups, folderMap);

  // Generate summary
  const lastPath = dirPath.split(path.sep);
  const lastDir = lastPath[lastPath.length - 1];

  console.log(`\nOrganization Summary for '${lastDir}':`);
  for (const key of Object.keys(results)) {
    const folderPath = folderMap.get(key);
    if (!folderPath) {
      console.error(`Error: No folder path found for key: ${key}`);
      continue;
    }
    const folderName = folderPath.split(path.sep).pop()!;
    console.log(`- Folder: ${folderName}`);
    console.log(`  - Files moved: ${results[key]}`);
  }
  console.timeEnd("Organization completed in"); // Outputs `Organization completed in: xxx ms`. This is optional and could be removed.
}
