module.exports = {
	ui: 'tdd',
	spec: 'out/test/**/*.test.js',
	ignore: 'out/test/extension.test.js',
	require: './test/unit/register.js',
	timeout: 5000,
};
