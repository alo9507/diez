import {
  canRunCommand,
  devDependencies,
  diezVersion,
  execAsync,
  Format,
  loadingMessage,
  Log,
} from '@diez/cli-core';
import {downloadStream, getTempFileName, outputTemplatePackage} from '@diez/storage';
import {
  camelCase,
  constantCase,
  dotCase,
  headerCase,
  kebabCase,
  lowerCase,
  noCase,
  pascalCase,
  snakeCase,
  titleCase,
} from 'change-case';
import {spawnSync} from 'child_process';
import {ensureDirSync, existsSync, lstatSync} from 'fs-extra';
import {basename, join, relative, resolve} from 'path';
import {x} from 'tar';
import validateNpmPackageName from 'validate-npm-package-name';
import {initializeGitRepository} from './utils.git';

const examplesProjectUrl = `https://examples.diez.org/${diezVersion}/createproject/project.tgz`;

/**
 * Validates that a package name is valid and nonconflicting.
 */
const validatePackageName = (packageName: string) => {
  const validationResult = validateNpmPackageName(packageName);
  if (!validationResult.validForNewPackages) {
    const warnings = [];
    if (validationResult.errors) {
      warnings.push(...validationResult.errors.map((message) => ` - ${message}`));
    }
    if (validationResult.warnings) {
      warnings.push(...validationResult.warnings.map((message) => ` - ${message}`));
    }

    if (warnings.length) {
      Log.warning('Project name validation failed:');
      Log.warning(...warnings);
    }

    throw new Error(`Unable to create project with name ${packageName}.`);
  }
};

/**
 * Provides an async check for if we are equipped to use `yarn` for package management operations.
 * @internal
 */
const shouldUseYarn = () => canRunCommand('yarnpkg --version');

/**
 * Provides an async check for if we are equipped to use `npm` in the current root as fallback for package management
 * operations.
 *
 * @see {@link https://github.com/facebook/create-react-app/blob/7864ba3/packages/create-react-app/createReactApp.js#L826}.
 * @ignore
 */
export const canUseNpm = async (root: string) => {
  let childOutput = null;
  try {
    // Note: intentionally using `spawn` over `exec` since
    // some scenarios doesn't reproduce otherwise.
    // `npm config list` is the only reliable way I could find
    // to reproduce the wrong path. Just printing process.cwd()
    // in a Node process was not enough.
    childOutput = spawnSync('npm', ['config', 'list']).output.join('');
  } catch (_) {
    // Something went wrong spawning node.
    // Not great, but it means we can't do this check.
    return true;
  }
  if (typeof childOutput !== 'string') {
    return true;
  }

  // `npm config list` output includes the following line:
  // "; cwd = C:\path\to\current\dir" (unquoted)
  const matches = childOutput.match(/^; cwd = (.*)$/m);
  if (matches === null) {
    // Fail gracefully. They could remove it.
    return true;
  }

  return matches[1] === root;
};

/**
 * Validates that a directory can be used as a project root.
 *
 * @internal
 */
const validateProjectRoot = async (root: string, useYarn = false) => {
  if (existsSync(root) && !lstatSync(root).isDirectory()) {
    throw new Error(`Found a non-directory at ${root}.`);
  }

  ensureDirSync(root);
  if (existsSync(join(root, 'package.json'))) {
    throw new Error(`A Node.js project already exists at ${root}.`);
  }

  if (useYarn) {
    return;
  }

  if (!await canUseNpm(root)) {
    throw new Error(`Unable to start an NPM process in ${root}.`);
  }
};

const downloadAndExtractProject = async (templateRoot: string) => {
  Log.info('Downloading template project from the Diez CDN...');
  const stream = await downloadStream(examplesProjectUrl);
  if (!stream) {
    throw new Error('Unable to download template project from examples.diez.org. Please try again.');
  }

  const writeStream = x({cwd: templateRoot});
  stream.pipe(writeStream);

  return new Promise((onComplete) => writeStream.on('close', onComplete));
};

const createTemplateProject = async (cwd: string, name: string) => {
  const templateRoot = resolve(getTempFileName(), 'examples');
  ensureDirSync(templateRoot);
  await downloadAndExtractProject(templateRoot);

  const pascalCased = pascalCase(name);
  const lowerCased = lowerCase(pascalCased);
  const tokens = {
    openTag: '{{',
    closeTag: '}}',
    namePascalCase: pascalCased,
    nameLowerCase: lowerCased,
    nameKebabCase: kebabCase(name),
    nameCamelCase: camelCase(name),
    nameTitleCase: titleCase(name),
    nameNoCase: noCase(name),
    nameSnakeCase: snakeCase(name),
    nameConstantCase: constantCase(name),
    nameHeaderCase: headerCase(name),
    nameDotCase: dotCase(name),
  };

  return outputTemplatePackage(templateRoot, cwd, tokens);
};

/**
 * Creates a project with the given name in the specified current working directory.
 * @ignore
 */
export const createProject = async (packageName: string, bare: boolean, cwd = process.cwd()) => {
  validatePackageName(packageName);

  const useYarn = await shouldUseYarn();
  const root = resolve(cwd, basename(packageName));
  await validateProjectRoot(root, useYarn);

  if (bare) {
    const tokens = {
      packageName,
      diezVersion,
      typescriptVersion: devDependencies.typescript,
      componentName: pascalCase(basename(packageName)),
    };
    await outputTemplatePackage(
      resolve(__dirname, '..', 'templates', 'project'), root, tokens);
  } else {
    try {
      await createTemplateProject(cwd, packageName);
    } catch (error) {
      Log.warning('Unable to download template project from the Diez CDN. Are you connected to the internet?');
      Log.warning(`If you would like to generate an empty project, you can re-run this command with ${Format.code('--bare')}.`);
      throw error;
    }
  }

  const message = loadingMessage('Installing dependencies. This might take a couple of minutes.');
  try {
    await execAsync(`${useYarn ? 'yarn' : 'npm'} install`, {cwd: root});
  } catch (error) {
    Log.warning('Unable to install dependencies. Are you connected to the Internet?');
    Log.warning(`You may need to run ${Format.code(`${useYarn ? 'yarn' : 'npm'} install`)} before ${Format.code('diez')} commands will work.`);
  }

  message.stop();

  try {
    await initializeGitRepository(root);
    Log.info(`Initialized a Git repository at ${root}`);
  } catch (error) {
    // Ignore errors.
  }

  Log.info(`Success! A new Diez (DS) has been created at ${Format.comment(root)}.
`);
  Log.info(`In that directory, the ${Format.code('diez')} command line utility can be invoked using:
  ${Format.code(`${useYarn ? 'yarn' : 'npm run'} diez`)}
`);
  if (bare) {
    Log.info(`To see a list of available commands, you can run:
  ${Format.code(`cd ${relative(cwd, root)}
  ${useYarn ? 'yarn' : 'npm run'} diez --help`)}`);
  } else {
    Log.info(`To get started, we suggest running:
  ${Format.code(`cd ${relative(cwd, root)}
  ${useYarn ? 'yarn' : 'npm run'} demo`)}
`);
    Log.info('Check out https://beta.diez.org/getting-started to learn more.');
  }
};
