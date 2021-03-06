/* jshint node: true */
'use strict';

var Funnel = require('broccoli-funnel');
var Writer = require('broccoli-writer');
var walkSync = require('walk-sync');
var fs = require('fs');
var path = require('path');
var symlinkOrCopy = require('symlink-or-copy');
var css = require('css');

var guid = function fn (n) {
  return n ?
           (n ^ Math.random() * 16 >> n/4).toString(16) :
           ('10000000'.replace(/[018]/g, fn));
};

function BrocComponentCssPreprocessor(inputTree) {
  this.inputTree = inputTree;
}

BrocComponentCssPreprocessor.prototype = Object.create(Writer.prototype);
BrocComponentCssPreprocessor.prototype.constructor = BrocComponentCssPreprocessor;

var CSS_SUFFIX = /\.css$/;

var podLookup = Object.create(null);

var HAS_AMPERSAND = /&/;

function isValidSelector(selector) {
  var parts = selector.split(/\s+/);
  var part;
  var isValid = true;

  for (var i = 0, l = parts.length; i < l; i++) {
    part = parts[i];
    if (part === '&' || part === '>') { continue; }
    if (part[0] !== '.') {
      isValid = false;
      break;
    }
  }

  return isValid;
}

function transformCSS(podName, podGuid, parsedCss) {
  var rules = parsedCss.stylesheet.rules;

  rules.forEach(function(rule) {
    rule.selectors = rule.selectors.map(function(selector) {
      if (!isValidSelector(selector)) {
        var message = 'Invalid selector specified in ' + podName + '/styles.css: ' + selector;
        message += '\nOnly class-based selectors (`.foo`) or `&` can be used inside of component styles.';
        throw new Error(message);
      }
      if (HAS_AMPERSAND.test(selector)) { // TODO: handle ampersand with component prefix properly
        return selector.replace('&', '.' + podGuid);
      } else {
        // TODO: handle descendant operator propertly (.foo > .bar)
        var selectorGuid = podName + "-" + selector.replace(/^\./, '') + "-" + guid();
        podLookup[podName + selector] = selectorGuid;
        return '.' + selectorGuid;
      }
    });
  });

  return parsedCss;
}

BrocComponentCssPreprocessor.prototype.write = function (readTree, destDir) {
  return readTree(this.inputTree).then(function(srcDir) {
    var buffer = [];
    var paths = walkSync(srcDir);
    var filepath;
    for (var i = 0, l = paths.length; i < l; i++) {
      filepath = paths[i];
      if (!CSS_SUFFIX.test(filepath)) { continue; }
      var podName = filepath.split('/')[0];
      var podGuid = podName + '-' + guid();
      var cssFileContents = fs.readFileSync(path.join(srcDir, filepath)).toString();
      var parsedCss = css.parse(cssFileContents);
      var transformedParsedCSS = transformCSS(podName, podGuid, parsedCss);
      buffer.push(css.stringify(transformedParsedCSS));
      podLookup[podName] = podGuid;
    }

    fs.writeFileSync(path.join(destDir, 'pod-styles.css'), buffer.join(''));
    fs.writeFileSync(path.join(destDir, 'pod-lookup.json'), JSON.stringify(podLookup));
  });
};

function ComponentCssPostprocessor(inputTree) {
  this.inputTree = inputTree;
}

ComponentCssPostprocessor.prototype = Object.create(Writer.prototype);
ComponentCssPostprocessor.prototype.constructor = ComponentCssPostprocessor;

ComponentCssPostprocessor.prototype.write = function (readTree, destDir) {
  return readTree(this.inputTree).then(function(srcDir) {
    var paths = walkSync(srcDir);
    var currentPath;
    var cssInjectionSource;
    for (var i = 0, l = paths.length; i < l; i++) {
      currentPath = paths[i];
      if (currentPath === "pod-lookup.json") {
        var podLookupFilepath = path.join(srcDir, "pod-lookup.json");
        var podLookup = fs.readFileSync(podLookupFilepath);
        cssInjectionSource = "\n\nEmber.COMPONENT_CSS_LOOKUP = " + podLookup + ";\n";
        cssInjectionSource += "Ember.ComponentLookup.reopen({\n" +
          "  lookupFactory: function(name, container) {\n" +
          "    var Component = this._super(name, container);\n" +
          "    if (!Component) { return; }\n" +
          "    return Component.reopen({\n" +
          "      classNames: [Ember.COMPONENT_CSS_LOOKUP[name]]\n" +
          "    });\n" +
          "  }\n" +
          "});\n";
      } else {
        if (currentPath[currentPath.length-1] === '/') {
          fs.mkdirSync(path.join(destDir, currentPath));
        } else {
          symlinkOrCopy.sync(path.join(srcDir, currentPath), path.join(destDir, currentPath));
        }
      }
    }

    fs.appendFileSync(path.join(destDir, "assets", "vendor.js"), cssInjectionSource);
    fs.appendFileSync(path.join(destDir, "assets", "vendor.css"), fs.readFileSync(path.join(srcDir, 'pod-styles.css')));
  });
};

function ComponentCSSPreprocessor(options) {
  this.name = 'component-css';
  this.options = options || {};
}

ComponentCSSPreprocessor.prototype.toTree = function(tree, inputPath, outputPath) {
  var filteredTree = new Funnel(tree, {
    srcDir: 'app',
    exclude: [/^styles/]
  });
  return new BrocComponentCssPreprocessor(filteredTree);
};

function monkeyPatch(EmberApp) {
  var pickFiles   = require('ember-cli/lib/broccoli/custom-static-compiler');
  var upstreamMergeTrees  = require('broccoli-merge-trees');
  var p     = require('ember-cli/lib/preprocessors');
  var preprocessCss = p.preprocessCss;

  function mergeTrees(inputTree, options) {
    var tree = upstreamMergeTrees(inputTree, options);

    tree.description = options && options.description;

    return tree;
  }

  EmberApp.prototype._filterAppTree = function() {
    if (this._cachedFilterAppTree) {
      return this._cachedFilterAppTree;
    }

    var excludePatterns = [].concat(
      this._podTemplatePatterns(),
      this._podStylePatterns(),
      [
        // note: do not use path.sep here Funnel uses
        // walk-sync which always joins with `/` (not path.sep)
        new RegExp('^styles/'),
        new RegExp('^templates/'),
      ]
    );

    return this._cachedFilterAppTree = new Funnel(this.trees.app, {
      exclude: excludePatterns,
      description: 'Funnel: Filtered App'
    });
  };

  EmberApp.prototype._podStylePatterns = function() {
    return this.registry.extensionsForType('css').map(function(extension) {
      return new RegExp(extension + '$');
    });
  };

  EmberApp.prototype.styles = function() {
    var addonTrees = this.addonTreesFor('styles');
    var external = this._processedExternalTree();
    var styles = pickFiles(this.trees.styles, {
      srcDir: '/',
      destDir: '/app/styles'
    });

    var podStyles = new Funnel(this.trees.app, {
      include: this._podStylePatterns(),
      exclude: [ /^styles/ ],
      destDir: '/app',
      description: 'Funnel: Pod Styles'
    });

    var trees = [external].concat(addonTrees, podStyles, styles);

    var stylesAndVendor = mergeTrees(trees, {
      description: 'TreeMerger (stylesAndVendor)'
    });

    var options = { outputPaths: this.options.outputPaths.app.css };
    options.registry = this.registry;
    var processedStyles = preprocessCss(stylesAndVendor, '/app/styles', '/assets', options);
    var vendorStyles    = this.concatFiles(stylesAndVendor, {
      inputFiles: this.vendorStaticStyles.concat(['vendor/addons.css']),
      outputFile: this.options.outputPaths.vendor.css,
      description: 'Concat: Vendor Styles'
    });

    if (this.options.minifyCSS.enabled === true) {
      options = this.options.minifyCSS.options || {};
      options.registry = this.registry;
      processedStyles = preprocessMinifyCss(processedStyles, options);
      vendorStyles    = preprocessMinifyCss(vendorStyles, options);
    }

    return mergeTrees([
        processedStyles,
        vendorStyles
      ], {
        description: 'styles'
      });
  };
}

module.exports = {
  name: 'ember-component-css',

  included: function(app) {
    monkeyPatch(app.constructor);
    this.app = app;
    var plugin = new ComponentCSSPreprocessor();
    this.app.registry.add('css', plugin);
  },

  postprocessTree: function(type, workingTree) {
    if (type === 'all') {
      return new ComponentCssPostprocessor(workingTree);
    }
    return workingTree;
  },

  setupPreprocessorRegistry: function(type, registry) {
    registry.add('htmlbars-ast-plugin', {
      name: "transform-component-layout",
      plugin: require('./ext/plugins/transform-component-layout')
    });
  }
};
