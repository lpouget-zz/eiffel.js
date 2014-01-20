var path        = require("path");
var fs        = require("fs");
var JSHINT = require("jshint").JSHINT;

// Storage for memoized results from find file
// Should prevent lots of directory traversal &
// lookups when liniting an entire project
var findFileResults = {};

/**
 * Tries to find a configuration file in either project directory
 * or in the home directory. Configuration files are named
 * '.jshintrc'.
 *
 * @param {string} file path to the file to be linted
 * @returns {string} a path to the config file
 */
function findConfig(file) {
		var dir  = path.dirname(path.resolve(file));
		var envs = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;
		var home = path.normalize(path.join(envs, ".jshintrc"));

		var proj = findFile(".jshintrc", dir);
		if (proj)
			return proj;

		if(fs.existsSync(home))
			return home;

		return null;
}

/**
 * Loads and parses a configuration file.
 *
 * @param {string} fp a path to the config file
 * @returns {object} config object
 */
function loadConfig (fp) {
	if (!fp) {
			return {};
	}

	if (!fs.existsSync(fp)) {
			cli.error("Can't find config file: " + fp);
			process.exit(1);
	}

	try {
			var config = JSON.parse(removeComments(shjs.cat(fp)));
			config.dirname = path.dirname(fp);

			if (config['extends']) {
					_.defaults(config, exports.loadConfig(path.resolve(config.dirname, config['extends'])));
					delete config['extends'];
			}

			return config;
	} catch (err) {
			cli.error("Can't parse config file: " + fp);
			process.exit(1);
	}
}

/**
 * Tries to find JSHint configuration within a package.json file
 * (if any). It search in the current directory and then goes up
 * all the way to the root just like findFile.
 *
 * @param   {string} file path to the file to be linted
 * @returns {object} config object
 */
function loadNpmConfig(file) {
		var dir = path.dirname(path.resolve(file));
		var fp  = findFile("package.json", dir);

		if (!fp)
				return null;

		try {
				return require(fp).jshintConfig;
		} catch (e) {
				return null;
		}
}

/**
 * Loads a list of files that have to be skipped. JSHint assumes that
 * the list is located in a file called '.jshintignore'.
 *
 * @return {array} a list of files to ignore.
 */
function loadIgnores(exclude, excludePath) {
		var file = findFile(excludePath || ".jshintignore");

		if (!file && !exclude) {
				return [];
		}

		var lines = (file ? shjs.cat(file) : "").split("\n");
		lines.unshift(exclude || "");

		return lines
				.filter(function (line) {
						return !!line.trim();
				})
				.map(function (line) {
						if (line[0] === "!")
								return "!" + path.resolve(path.dirname(file), line.substr(1).trim());

						return path.resolve(path.dirname(file), line.trim());
				});
}

/**
 * Searches for a file with a specified name starting with
 * 'dir' and going all the way up either until it finds the file
 * or hits the root.
 *
 * @param {string} name filename to search for (e.g. .jshintrc)
 * @param {string} dir  directory to start search from (default:
 *                                                                                  current working directory)
 *
 * @returns {string} normalized filename
 */
function findFile(name, dir) {
		dir = dir || process.cwd();

		var filename = path.normalize(path.join(dir, name));
		if (findFileResults[filename] !== undefined) {
				return findFileResults[filename];
		}

		var parent = path.resolve(dir, "../");

		if (fs.existsSync(path.resolve(parent, filename))) {
				findFileResults[filename] = filename;
				return filename;
		}

		if (dir === parent) {
				findFileResults[filename] = null;
				return null;
		}

		return findFile(name, parent);
}

/**
 * Checks whether we should ignore a file or not.
 *
 * @param {string} fp       a path to a file
 * @param {array}  patterns a list of patterns for files to ignore
 *
 * @return {boolean} 'true' if file should be ignored, 'false' otherwise.
 */
function isIgnored(fp, patterns) {
		return patterns.some(function (ip) {
				if (minimatch(path.resolve(fp), ip, { nocase: true })) {
						return true;
				}

				if (path.resolve(fp) === ip) {
						return true;
				}

				if (fs.existsSync(fp) && ip.match(/^[^\/]*\/?$/) &&
						fp.match(new RegExp("^" + ip + ".*"))) {
						return true;
				}
		});
}

/**
 * Extract JS code from a given source code. The source code my be either HTML
 * code or JS code. In the latter case, no extraction will be done unless
 * 'always' is given.
 *
 * @param {string} code a piece of code
 * @param {string} when 'always' will extract the JS code, no matter what.
 * 'never' won't do anything. 'auto' will check if the code looks like HTML
 * before extracting it.
 *
 * @return {string} the extracted code
 */
function extract(code, when) {
		// A JS file won't start with a less-than character, whereas a HTML file
		// should always start with that.
		if (when !== "always" && (when !== "auto" || !/^\s*</.test(code)))
				return code;

		var inscript = false;
		var index = 0;
		var js = [];

		// Test if current tag is a valid <script> tag.
		function onopen(name, attrs) {
				if (name !== "script")
						return;

				if (attrs.type && !/text\/javascript/.test(attrs.type.toLowerCase()))
						return;

				// Mark that we're inside a <script> a tag and push all new lines
				// in between the last </script> tag and this <script> tag to preserve
				// location information.
				inscript = true;
				js.push.apply(js, code.slice(index, parser.endIndex).match(/\n\r|\n|\r/g));
		}

		function onclose(name) {
				if (name !== "script" || !inscript)
						return;

				inscript = false;
				index = parser.startIndex;
		}

		function ontext(data) {
				if (inscript)
						js.push(data); // Collect JavaScript code.
		}

		var parser = new htmlparser.Parser({ onopentag: onopen, onclosetag: onclose, ontext: ontext });
		parser.parseComplete(code);

		return js.join("");
}

/**
 * Recursively gather all files that need to be linted,
 * excluding those that user asked to ignore.
 *
 * @param {string} fp      a path to a file or directory to lint
 * @param {array}  files   a pointer to an array that stores a list of files
 * @param {array}  ignores a list of patterns for files to ignore
 * @param {array}  ext     a list of non-dot-js extensions to lint
 */
function collect(fp, files, ignores, ext) {
		if (ignores && isIgnored(fp, ignores)) {
				return;
		}

		if (!fs.existsSync(fp)) {
				console.log("Can't open " + fp);
				return;
		}

		var stats = fs.statSync(fp);

		if (stats.isDirectory()) {
			fs.readdir(fp, function (err, item) {
				if(!err) {
					var itempath = path.join(fp, item);

					if (fs.existsSync(itempath) || item.match(ext)) {
							collect(itempath, files, ignores, ext);
					}
				} else {
					console.log(err);
				}
			});

			return;
		}

		files.push(fp);
}

/**
 * Runs JSHint against provided file and saves the result
 *
 * @param {string} code    code that needs to be linted
 * @param {object} results a pointer to an object with results
 * @param {object} config  an object with JSHint configuration
 * @param {object} data    a pointer to an object with extra data
 * @param {string} file    (optional) file name that is being linted
 */
function lint(code, results, config, data, file) {
		var globals;
		var lintData;
		var buffer = [];

		config = config || {};
		config = JSON.parse(JSON.stringify(config));

		if (config.prereq) {
				config.prereq.forEach(function (fp) {
						fp = path.join(config.dirname, fp);
						if (fs.existsSync(fp))
								buffer.push(shjs.cat(fp));
				});
				delete config.prereq;
		}

		if (config.globals) {
				globals = config.globals;
				delete config.globals;
		}

		delete config.dirname;
		buffer.push(code);
		buffer = buffer.join("\n");
		buffer = buffer.replace(/^\uFEFF/, ""); // Remove potential Unicode BOM.

		if (!JSHINT(buffer, config, globals)) {
				JSHINT.errors.forEach(function (err) {
						if (err) {
								results.push({ file: file || "stdin", error: err });
						}
				});
		}

		lintData = JSHINT.data();

		if (lintData) {
				lintData.file = file || "stdin";
				data.push(lintData);
		}
}

var exports = {
	/**
	 * Gathers all files that need to be linted
	 *
	 * @param {object} post-processed options from 'interpret':
	 *                                                                   args     - CLI arguments
	 *                                                                   ignores  - A list of files/dirs to ignore (defaults to .jshintignores)
	 *                                                                   extensions - A list of non-dot-js extensions to check
	 */
	gather: function (opts) {
			var files = [];

			var reg = new RegExp("\\.(js" +
					(!opts.extensions ? "" : "|" +
							opts.extensions.replace(/,/g, "|").replace(/[\. ]/g, "")) + ")$");

			var ignores = !opts.ignores ? loadIgnores() : opts.ignores.map(function (target) {
					return path.resolve(target);
			});

			opts.args.forEach(function (target) {
					collect(target, files, ignores, reg);
			});

			return files;
	},

	/**
	 * Gathers all files that need to be linted, lints them, sends them to
	 * a reporter and returns the overall result.
	 *
	 * @param {object} post-processed options from 'interpret':
	 *                 args     - CLI arguments
	 *                 config   - Configuration object
	 *                 reporter - Reporter function
	 *                 ignores  - A list of files/dirs to ignore
	 *                 extensions - A list of non-dot-js extensions to check
	 * @param {function} cb a callback to call when function is finished
	 *                   asynchronously.
	 *
	 * @returns {bool} 'true' if all files passed, 'false' otherwise and 'null'
	 *                 when function will be finished asynchronously.
	 */
	/**
	 * Options sample : {
	 *         args:       cli.args,
	 *         config:     config,
	 *         reporter:   reporter,
	 *         ignores:    loadIgnores(options.exclude, options["exclude-path"]),
	 *         extensions: options["extra-ext"],
	 *         verbose:    options.verbose,
	 *         extract:    options.extract,
	 *         useStdin:   {"-": true, "/dev/stdin": true}[args[args.length - 1]]
	 * }
	 */
	run: function (opts, cb) {
		var files = exports.gather(opts);
		var results = [];
		var data = [];

		console.log(files);

		files.forEach(function (file) {
				var config = opts.config || loadNpmConfig(file) || loadConfig(findConfig(file));
				var code;

				try {
						code = fs.readFileSync(file);
				} catch (err) {
						console.log("Can't open " + file);
						process.exit(1);
				}

				lint(extract(code, opts.extract), results, config, data, file);
		});

		results.forEach(function(result) {
			console.log(result);
		});

		//(opts.reporter || defReporter)(results, data, { verbose: opts.verbose });
		return results.length === 0;
	}
};

exports.run({args: ["index.js"]});