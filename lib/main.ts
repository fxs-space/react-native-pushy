import {
  tryBackupEndpoints,
  getCheckUrl,
  setCustomEndpoints,
} from './endpoint';
import {
  NativeEventEmitter,
  NativeModules,
  Platform,
  PermissionsAndroid,
} from 'react-native';
import {
  CheckResult,
  EventType,
  ProgressData,
  UpdateAvailableResult,
  UpdateEventsListener,
} from './type';
export { setCustomEndpoints };
const {
  version: v,
} = require('react-native/Libraries/Core/ReactNativeVersion');
const RNVersion = `${v.major}.${v.minor}.${v.patch}`;
const isTurboModuleEnabled = global.__turboModuleProxy != null;

export const PushyModule = isTurboModuleEnabled
  ? require('./NativeUpdate').default
  : NativeModules.Pushy;

if (!PushyModule) {
  throw new Error('react-native-update模块无法加载，请对照安装文档检查配置。');
}
const PushyConstants = isTurboModuleEnabled
  ? PushyModule.getConstants()
  : PushyModule;

export const downloadRootDir = PushyConstants.downloadRootDir;
export const packageVersion = PushyConstants.packageVersion;
export const currentVersion = PushyConstants.currentVersion;
export const isFirstTime = PushyConstants.isFirstTime;
const rolledBackVersion = PushyConstants.rolledBackVersion;
export const isRolledBack = typeof rolledBackVersion === 'string';

export const buildTime = PushyConstants.buildTime;
let blockUpdate = PushyConstants.blockUpdate;
let uuid = PushyConstants.uuid;

if (Platform.OS === 'android' && !PushyConstants.isUsingBundleUrl) {
  throw new Error(
    'react-native-update模块无法加载，请对照文档检查Bundle URL的配置',
  );
}

function setLocalHashInfo(hash: string, info: Record<string, any>) {
  PushyModule.setLocalHashInfo(hash, JSON.stringify(info));
}

async function getLocalHashInfo(hash: string) {
  return JSON.parse(await PushyModule.getLocalHashInfo(hash));
}

export async function getCurrentVersionInfo(): Promise<{
  name?: string;
  description?: string;
  metaInfo?: string;
}> {
  return currentVersion ? (await getLocalHashInfo(currentVersion)) || {} : {};
}

const eventEmitter = new NativeEventEmitter(PushyModule);

if (!uuid) {
  uuid = require('nanoid/non-secure').nanoid();
  PushyModule.setUuid(uuid);
}

function logger(...args: string[]) {
  console.log('Pushy: ', ...args);
}

const noop = () => {};
let reporter: UpdateEventsListener = noop;

export function onEvents(customReporter: UpdateEventsListener) {
  reporter = customReporter;
  if (isRolledBack) {
    report({
      type: 'rollback',
      data: {
        rolledBackVersion,
      },
    });
  }
}

function report({
  type,
  message = '',
  data = {},
}: {
  type: EventType;
  message?: string;
  data?: Record<string, string | number>;
}) {
  logger(type + ' ' + message);
  reporter({
    type,
    data: {
      currentVersion,
      cInfo,
      packageVersion,
      buildTime,
      message,
      ...data,
    },
  });
}

logger('uuid: ' + uuid);

export const cInfo = {
  pushy: require('../package.json').version,
  rn: RNVersion,
  os: Platform.OS + ' ' + Platform.Version,
  uuid,
};

function assertRelease() {
  if (__DEV__) {
    throw new Error('react-native-update 只能在 RELEASE 版本中运行.');
  }
}

let lastChecking;
const empty = {};
let lastResult: CheckResult;
export async function checkUpdate(APPKEY: string, isRetry?: boolean) {
  assertRelease();
  const now = Date.now();
  if (lastResult && lastChecking && now - lastChecking < 1000 * 60) {
    // logger('repeated checking, ignored');
    return lastResult;
  }
  lastChecking = now;
  if (blockUpdate && blockUpdate.until > Date.now() / 1000) {
    report({
      type: 'errorChecking',
      message: `热更新已暂停，原因：${blockUpdate.reason}。请在"${new Date(
        blockUpdate.until * 1000,
      ).toLocaleString()}"之后重试。`,
    });
    return lastResult || empty;
  }
  report({ type: 'checking' });
  let resp;
  try {
    resp = await fetch(getCheckUrl(APPKEY), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        packageVersion,
        hash: currentVersion,
        buildTime,
        cInfo,
      }),
    });
  } catch (e) {
    if (isRetry) {
      report({
        type: 'errorChecking',
        message: '无法连接更新服务器，请检查网络连接后重试',
      });
      return lastResult || empty;
    }
    await tryBackupEndpoints();
    return checkUpdate(APPKEY, true);
  }
  const result: CheckResult = await resp.json();

  lastResult = result;
  // @ts-ignore
  checkOperation(result.op);

  if (resp.status !== 200) {
    report({
      type: 'errorChecking',
      //@ts-ignore
      message: result.message,
    });
  }

  return result;
}

function checkOperation(
  op: { type: string; reason: string; duration: number }[],
) {
  if (!Array.isArray(op)) {
    return;
  }
  op.forEach((action) => {
    if (action.type === 'block') {
      blockUpdate = {
        reason: action.reason,
        until: Math.round((Date.now() + action.duration) / 1000),
      };
      PushyModule.setBlockUpdate(blockUpdate);
    }
  });
}

let downloadingThrottling = false;
let downloadedHash: string;
export async function downloadUpdate(
  options: UpdateAvailableResult,
  eventListeners?: {
    onDownloadProgress?: (data: ProgressData) => void;
  },
) {
  assertRelease();
  if (!options.update) {
    return;
  }
  if (rolledBackVersion === options.hash) {
    logger(`rolledback hash ${rolledBackVersion}, ignored`);
    return;
  }
  if (downloadedHash === options.hash) {
    logger(`duplicated downloaded hash ${downloadedHash}, ignored`);
    return downloadedHash;
  }
  if (downloadingThrottling) {
    logger('repeated downloading, ignored');
    return;
  }
  downloadingThrottling = true;
  setTimeout(() => {
    downloadingThrottling = false;
  }, 3000);
  let progressHandler;
  if (eventListeners) {
    if (eventListeners.onDownloadProgress) {
      const downloadCallback = eventListeners.onDownloadProgress;
      progressHandler = eventEmitter.addListener(
        'RCTPushyDownloadProgress',
        (progressData) => {
          if (progressData.hash === options.hash) {
            downloadCallback(progressData);
          }
        },
      );
    }
  }
  let succeeded = false;
  report({ type: 'downloading' });
  if (options.diffUrl) {
    logger('downloading diff');
    try {
      await PushyModule.downloadPatchFromPpk({
        updateUrl: options.diffUrl,
        hash: options.hash,
        originHash: currentVersion,
      });
      succeeded = true;
    } catch (e) {
      logger(`diff error: ${e.message}, try pdiff`);
    }
  }
  if (!succeeded && options.pdiffUrl) {
    logger('downloading pdiff');
    try {
      await PushyModule.downloadPatchFromPackage({
        updateUrl: options.pdiffUrl,
        hash: options.hash,
      });
      succeeded = true;
    } catch (e) {
      logger(`pdiff error: ${e.message}, try full patch`);
    }
  }
  if (!succeeded && options.updateUrl) {
    logger('downloading full patch');
    try {
      await PushyModule.downloadFullUpdate({
        updateUrl: options.updateUrl,
        hash: options.hash,
      });
      succeeded = true;
    } catch (e) {
      logger(`full patch error: ${e.message}`);
    }
  }
  progressHandler && progressHandler.remove();
  if (!succeeded) {
    return report({ type: 'errorUpdate', data: { newVersion: options.hash } });
  }
  setLocalHashInfo(options.hash, {
    name: options.name,
    description: options.description,
    metaInfo: options.metaInfo,
  });
  downloadedHash = options.hash;
  return options.hash;
}

function assertHash(hash: string) {
  if (!downloadedHash) {
    logger(`no downloaded hash`);
    return;
  }
  if (hash !== downloadedHash) {
    logger(`use downloaded hash ${downloadedHash} first`);
    return;
  }
  return true;
}

export function switchVersion(hash: string) {
  assertRelease();
  if (assertHash(hash)) {
    logger('switchVersion: ' + hash);
    PushyModule.reloadUpdate({ hash });
  }
}

export function switchVersionLater(hash: string) {
  assertRelease();
  if (assertHash(hash)) {
    logger('switchVersionLater: ' + hash);
    PushyModule.setNeedUpdate({ hash });
  }
}

let marked = false;
export function markSuccess() {
  assertRelease();
  if (marked) {
    logger('repeated markSuccess, ignored');
    return;
  }
  marked = true;
  PushyModule.markSuccess();
  report({ type: 'markSuccess' });
}

export async function downloadAndInstallApk({
  url,
  onDownloadProgress,
}: {
  url: string;
  onDownloadProgress?: (data: ProgressData) => void;
}) {
  if (Platform.OS !== 'android') {
    return;
  }
  report({ type: 'downloadingApk' });
  if (Platform.Version <= 23) {
    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        return report({ type: 'rejectStoragePermission' });
      }
    } catch (err) {
      return report({ type: 'errorStoragePermission' });
    }
  }
  let hash = Date.now().toString();
  let progressHandler;
  if (onDownloadProgress) {
    progressHandler = eventEmitter.addListener(
      'RCTPushyDownloadProgress',
      (progressData: ProgressData) => {
        if (progressData.hash === hash) {
          onDownloadProgress(progressData);
        }
      },
    );
  }
  await PushyModule.downloadAndInstallApk({
    url,
    target: 'update.apk',
    hash,
  }).catch(() => {
    report({ type: 'errowDownloadAndInstallApk' });
  });
  progressHandler && progressHandler.remove();
}
