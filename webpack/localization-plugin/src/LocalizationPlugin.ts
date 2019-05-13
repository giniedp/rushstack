// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as Webpack from 'webpack';
import * as path from 'path';
import * as lodash from 'lodash';

export interface ILocJsonFileData {
  [stringName: string]: string;
}

export interface ILocale {
  [locJsonFilePath: string]: ILocJsonFileData;
}

export interface ILocales {
  [locale: string]: ILocale;
}

/**
 * The options for localization.
 *
 * @public
 */
export interface ILocalizationPluginOptions {
  localizedStrings: ILocales;

  filesToIgnore?: string[];
}

/**
 * @internal
 */
export interface IStringPlaceholder {
  value: string;
  suffix: string;
}

const PLUGIN_NAME: string = 'localization';
const LOCALE_FILENAME_PLACEHOLDER: string = '[locale]';
const LOCALE_FILENAME_PLACEHOLDER_REGEX: RegExp = new RegExp(lodash.escapeRegExp(LOCALE_FILENAME_PLACEHOLDER), 'g');
const STRING_PLACEHOLDER_PREFIX: string = '-LOCALIZED-STRING-f12dy0i7-n4bo-dqwj-39gf-sasqehjmihz9';

interface IAsset {
  size(): number;
  source(): string;
}

/**
 * This plugin facilitates localization in webpack.
 *
 * @public
 */
export class LocalizationPlugin implements Webpack.Plugin {
  /**
   * @internal
   */
  public stringKeys: Map<string, IStringPlaceholder>;

  private _options: ILocalizationPluginOptions;
  private _locJsonFiles: Set<string>;
  private _locJsonFilesToIgnore: Set<string>;
  private _stringPlaceholderCounter: number;
  private _stringPlaceholderMap: Map<string, { [locale: string]: string }>;
  private _locales: Set<string>;

  constructor(options: ILocalizationPluginOptions) {
    this._options = options;
  }

  public apply(compiler: Webpack.Compiler): void {
    const isWebpack4: boolean = !!compiler.hooks;

    if (!isWebpack4) {
      throw new Error('The localization plugin requires webpack 4');
    }

    const errors: Error[] = this._initializeAndValidateOptions(compiler.options);
    this._ammendWebpackConfiguration(compiler.options);

    compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation: Webpack.compilation.Compilation) => {
      if (errors.length > 0) {
        compilation.errors.push(...errors);
      }
    });

    compiler.hooks.emit.tap(PLUGIN_NAME, (compilation: Webpack.compilation.Compilation) => {
      for (const chunkGroup of compilation.chunkGroups) {
        const children: Webpack.compilation.Chunk[] = chunkGroup.getChildren();
        if (
          (children.length > 0) && // Chunks found
          (
            !compiler.options.output ||
            !compiler.options.output.chunkFilename ||
            compiler.options.output.chunkFilename.indexOf(LOCALE_FILENAME_PLACEHOLDER) === -1
          )
        ) {
          compilation.errors.push(new Error(
            'The configuration.output.chunkFilename property must be provided and must include ' +
            `the ${LOCALE_FILENAME_PLACEHOLDER} placeholder`
          ));

          return;
        }
      }

      for (const assetName in compilation.assets) {
        if (compilation.assets.hasOwnProperty(assetName) && assetName.indexOf(LOCALE_FILENAME_PLACEHOLDER) !== -1) {
          const asset: IAsset = compilation.assets[assetName];
          const resultingAssets: { [assetName: string]: IAsset } = this._processAsset(
            compilation,
            assetName,
            asset
          );

          for (const newAssetName in resultingAssets) {
            if (resultingAssets.hasOwnProperty(newAssetName)) {
              const newAsset: IAsset = resultingAssets[newAssetName];
              compilation.assets[newAssetName] = newAsset;
            }
          }

          // TODO:
          //  - Decide what to do with the non-localized files
          //    (?) delete compilation.assets[assetName];
        }
      }
    });
  }

  private _processAsset(
    compilation: Webpack.compilation.Compilation,
    assetName: string,
    asset: IAsset
  ): { [assetName: string]: IAsset } {
    interface IReconstructionElement {
      kind: 'static' | 'localized';
    }

    interface IStaticReconstructionElement extends IReconstructionElement {
      kind: 'static';
      staticString: string;
    }

    interface ILocalizedReconstructionElement extends IReconstructionElement {
      kind: 'localized';
      values: { [locale: string]: string };
      size: number;
    }

    const placeholderRegex: RegExp = new RegExp(`${lodash.escapeRegExp(STRING_PLACEHOLDER_PREFIX)}_(\\d+)`, 'g');
    const result: { [assetName: string]: IAsset } = {};
    const assetSource: string = asset.source();

    const reconstructionSeries: IReconstructionElement[] = [];

    let lastIndex: number = 0;
    let regexResult: RegExpExecArray | null;
    while (regexResult = placeholderRegex.exec(assetSource)) {
      const staticElement: IStaticReconstructionElement = {
        kind: 'static',
        staticString: assetSource.substring(lastIndex, regexResult.index)
      };
      reconstructionSeries.push(staticElement);

      const [placeholder, placeholderSerialNumber] = regexResult;

      const values: { [locale: string]: string } | undefined = this._stringPlaceholderMap.get(placeholderSerialNumber);
      if (!values) {
        compilation.errors.push(new Error(`Missing placeholder ${placeholder}`));
        const brokenLocalizedElement: IStaticReconstructionElement = {
          kind: 'static',
          staticString: placeholder
        };
        reconstructionSeries.push(brokenLocalizedElement);
      } else {
        const localizedElement: ILocalizedReconstructionElement = {
          kind: 'localized',
          values: values,
          size: placeholder.length
        };
        reconstructionSeries.push(localizedElement);
        lastIndex = regexResult.index + placeholder.length;
      }
    }

    const lastElement: IStaticReconstructionElement = {
      kind: 'static',
      staticString: assetSource.substr(lastIndex)
    };
    reconstructionSeries.push(lastElement);

    this._locales.forEach((locale) => {
      const resultFilename: string = assetName.replace(LOCALE_FILENAME_PLACEHOLDER_REGEX, locale);
      const reconstruction: string[] = [];

      let sizeDiff: number = 0;
      for (const element of reconstructionSeries) {
        if (element.kind === 'static') {
          reconstruction.push((element as IStaticReconstructionElement).staticString);
        } else {
          const localizedElement: ILocalizedReconstructionElement = element as ILocalizedReconstructionElement;
          const newValue: string = localizedElement.values[locale];
          reconstruction.push(newValue);
          sizeDiff += (newValue.length - localizedElement.size);
        }
      }

      // TODO:
      //  - Ensure hot reloading works
      //  - Ensure stats.json is correct
      //  - Fixup source maps
      const newAsset: IAsset = lodash.clone(asset);
      const newAssetSource: string = reconstruction.join('');
      const newAssetSize: number = newAsset.size() + sizeDiff;
      newAsset.source = () => newAssetSource;
      newAsset.size = () => newAssetSize;
      result[resultFilename] = newAsset;
    });

    return result;
  }

  private _ammendWebpackConfiguration(configuration: Webpack.Configuration): void {
    if (!configuration.module) {
      configuration.module = {
        rules: []
      };
    }

    if (!configuration.module.rules) {
      configuration.module.rules = [];
    }

    configuration.module.rules.push({
      test: (filePath: string) => this._locJsonFiles.has(filePath.toUpperCase()),
      loader: path.resolve(__dirname, 'loaders', 'LocJsonLoader.js'),
      options: {
        pluginInstance: this
      }
    });

    configuration.module.rules.push({
      test: {
        and: [
          (filePath: string) => !this._locJsonFiles.has(filePath.toUpperCase()),
          (filePath: string) => !this._locJsonFilesToIgnore.has(filePath.toUpperCase()),
          /\.loc\.json$/i
        ]
      },
      loader: path.resolve(__dirname, 'loaders', 'LocJsonWarningLoader.js')
    });
  }

  private _initializeAndValidateOptions(configuration: Webpack.Configuration): Error[] {
    const errors: Error[] = [];

    // START configuration
    {
      if (
        !configuration.output ||
        !configuration.output.filename ||
        configuration.output.filename.indexOf(LOCALE_FILENAME_PLACEHOLDER) === -1
      ) {
        errors.push(new Error(
          'The configuration.output.filename property must be provided and must include ' +
          `the ${LOCALE_FILENAME_PLACEHOLDER} placeholder`
        ));
      }
    }
    // END configuration

    // START options.filesToIgnore
    {
      this._locJsonFilesToIgnore = new Set<string>();
      for (const locJsonFilePath of this._options.filesToIgnore || []) {
        let normalizedLocJsonFilePath: string = path.isAbsolute(locJsonFilePath)
          ? locJsonFilePath
          : path.resolve(configuration.context, locJsonFilePath);
        normalizedLocJsonFilePath = normalizedLocJsonFilePath.toUpperCase();
        this._locJsonFilesToIgnore.add(normalizedLocJsonFilePath);
      }
    }
    // END options.filesToIgnore

    // START options.localizedStrings
    {
      const { localizedStrings } = this._options;

      const localeNameRegex: RegExp = /[a-z-]/i;
      const definedStringsInLocJsonFiles: Map<string, Set<string>> = new Map<string, Set<string>>();
      this._locJsonFiles = new Set<string>();
      this.stringKeys = new Map<string, IStringPlaceholder>();
      this._stringPlaceholderMap = new Map<string, { [locale: string]: string }>();
      const normalizedLocales: Set<string> = new Set<string>();
      this._locales = new Set<string>();

      for (const localeName in localizedStrings) {
        if (localizedStrings.hasOwnProperty(localeName)) {
          const normalizedLocaleName: string = localeName.toUpperCase();
          if (normalizedLocales.has(normalizedLocaleName)) {
            errors.push(Error(
              `The locale "${localeName}" appears multiple times. ` +
              'There may be multiple instances with different casing.'
            ));
            return errors;
          }

          this._locales.add(localeName);
          normalizedLocales.add(normalizedLocaleName);

          if (!localeName.match(localeNameRegex)) {
            errors.push(new Error(
               `Invalid locale name: ${localeName}. Locale names may only contain letters and hyphens.`
            ));
            return errors;
          }

          const locFilePathsInLocale: Set<string> = new Set<string>();

          const locale: ILocale = localizedStrings[localeName];
          for (const locJsonFilePath in locale) {
            if (locale.hasOwnProperty(locJsonFilePath)) {
              let normalizedLocJsonFilePath: string = path.isAbsolute(locJsonFilePath)
                ? locJsonFilePath
                : path.resolve(configuration.context, locJsonFilePath);
              normalizedLocJsonFilePath = normalizedLocJsonFilePath.toUpperCase();

              if (this._locJsonFilesToIgnore.has(normalizedLocJsonFilePath)) {
                errors.push(new Error(
                  `The .loc.json file path "${locJsonFilePath}" is listed both in the filesToIgnore object and in ` +
                  'strings data.'
                ));
                return errors;
              }

              if (locFilePathsInLocale.has(normalizedLocJsonFilePath)) {
                errors.push(new Error(
                  `The .loc.json file path "${locJsonFilePath}" appears multiple times in locale ${localeName}. ` +
                  'There may be multiple instances with different casing.'
                ));
                return errors;
              }

              locFilePathsInLocale.add(normalizedLocJsonFilePath);

              if (!this._locJsonFiles.has(normalizedLocJsonFilePath)) {
                this._locJsonFiles.add(normalizedLocJsonFilePath);
              }

              const locJsonFileData: ILocJsonFileData = locale[locJsonFilePath];

              for (const stringName in locJsonFileData) {
                if (locJsonFileData.hasOwnProperty(stringName)) {
                  const stringKey: string = `${normalizedLocJsonFilePath}?${stringName}`;
                  if (!this.stringKeys.has(stringKey)) {
                    this.stringKeys.set(stringKey, this._getPlaceholderString());
                  }

                  const placeholder: IStringPlaceholder = this.stringKeys.get(stringKey)!;
                  if (!this._stringPlaceholderMap.has(placeholder.suffix)) {
                    this._stringPlaceholderMap.set(placeholder.suffix, {});
                  }

                  this._stringPlaceholderMap.get(placeholder.suffix)![localeName] = locJsonFileData[stringName];

                  if (!definedStringsInLocJsonFiles.has(stringKey)) {
                    definedStringsInLocJsonFiles.set(stringKey, new Set<string>());
                  }

                  definedStringsInLocJsonFiles.get(stringKey)!.add(normalizedLocaleName);
                }
              }
            }
          }
        }
      }

      const issues: string[] = [];
      definedStringsInLocJsonFiles.forEach((localesForString: Set<string>, stringKey: string) => {
        if (localesForString.size !== this._locales.size) {
          const missingLocales: string[] = [];
          this._locales.forEach((locale) => {
            if (!localesForString.has(locale)) {
              missingLocales.push(locale);
            }
          });

          const [locJsonPath, stringName] = stringKey.split('?');
          issues.push(
            `The string "${stringName}" in "${locJsonPath}" is missing in the ` +
            `following locales: ${missingLocales.join(', ')}`
          );
        }
      });

      if (issues.length > 0) {
        errors.push(Error(
          `Issues during localized string validation:\n${issues.map((issue) => `  ${issue}`).join('\n')}`
        ));
      }
    }
    // END options.localizedStrings

    return errors;
  }

  private _getPlaceholderString(): IStringPlaceholder {
    if (this._stringPlaceholderCounter === undefined) {
      this._stringPlaceholderCounter = 0;
    }

    const suffix: string = (this._stringPlaceholderCounter++).toString();
    return {
      value: `${STRING_PLACEHOLDER_PREFIX}_${suffix}`,
      suffix: suffix
    };
  }
}