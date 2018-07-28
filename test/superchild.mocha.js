var _ = require('lodash')
  , assert = require('chai').assert
  , fmt = require('util').format
  , path = require('path')
  , pstatus = require('./pstatus')
  , spawn = require('../lib/respawn').spawn
  , superchild = require('../lib/superchild')
  ;


describe('Superchild', function() {

  describe('basic use cases', function() {

    it('should get a long directory listing line-by-line', function(cb) {
      var child = superchild('ls -lh ' + __dirname);
      var lines = [];
      child.on('stdout_line', function(lineStr) {
        lines.push(lineStr);
      });
      child.once('exit', function(code, signal) {
        assert.equal(0, code, 'ls should terminate with zero exit code');
        assert.isAtLeast(lines.length, 3, 'ls should output the correct number of lines');
        cb();
      });
    });

    it('should filter and parse LD-JSON objects', function(cb) {
      var child = superchild('cat');
      var objects = [];
      child.on('json_object', function(jsonObj) {
        objects.push(jsonObj);
        child.close();
      });
      child.send({some: 'data'});
      child.once('exit', function(code, signal) {
        assert.isNotOk(code, 'ls should terminate with zero exit code');
        assert.equal(1, objects.length, 'ls should output the correct number of lines');
        assert.equal('data', objects[0].some, 'ls should echo data via cat and event json_object');
        cb();
      });
    });

    it('should filter and parse LD-JSON arrays', function(cb) {
      var child = superchild('cat');
      var arrays = [];
      child.on('json_array', function(jsonArr) {
        arrays.push(jsonArr);
        child.close();
      });
      child.send([1, 2, 3]);
      child.once('exit', function(code, signal) {
        assert.isNotOk(code, 'ls should terminate with zero exit code');
        assert.equal(1, arrays.length, 'ls should output the correct number of lines');
        assert.deepEqual([1, 2, 3], arrays[0], 'ls should echo data via cat and event json_array');
        cb();
      });
    });

    it('should process the last unterminated line on child exit', function(cb) {
      var child = superchild('echo "sentinel"');
      var firstLine;
      child.once('stdout_line', function(lineStr) {
        firstLine = lineStr;
      });
      child.once('exit', function() {
        assert.isOk(firstLine, 'should process the last unterminated line');
        assert.equal(firstLine, 'sentinel', 'should echo the correct string');
        cb();
      });
    });

    it('should process the last unterminated LD-JSON line on child exit', function(cb) {
      var child = superchild('echo "[123, 456, 789]"');
      var firstLine, firstArr;
      child.once('stdout_line', function(lineStr) {
        firstLine = lineStr;
      });
      child.once('json_array', function(jsonArr) {
        firstArr = jsonArr;
      });
      child.once('exit', function() {
        assert.isNotOk(firstLine, 'should not pass LD-JSON to stdout');
        assert.deepEqual(firstArr, [123, 456, 789], 'should parse the correct array');
        cb();
      });
    });

    it('should ignore invalid leading and trailing whitespace when parsing LD-JSON', function(cb) {
      var child = superchild('printf "\x1b \x1f \x10[123, 456, 789]  \x07"');
      var firstLine, firstArr;
      child.once('stdout_line', function(lineStr) {
        firstLine = lineStr;
      });
      child.once('json_array', function(jsonArr) {
        firstArr = jsonArr;
      });
      child.once('exit', function() {
        assert.isNotOk(firstLine, 'should not pass LD-JSON to stdout');
        assert.deepEqual(firstArr, [123, 456, 789], 'should parse the correct array');
        cb();
      });
    });

    // Child should emit exactly one message to each stream and then exit. The
    // order of received events should match the order of events sent.
    it('should receive stream events in the correct order', function(cb) {
      this.slow(2000);
      this.timeout(4000);
      var evts = [];
      var pushEvent = function(evtType) {
        return function(elem) {
          evts.push([evtType, elem]);
        };
      };
      var child = superchild('node stream-test.js', {cwd: path.join(__dirname, 'programs')});

      // Record events received, in order.
      child.on('stdout_line', pushEvent('stdout_line'));
      child.on('json_array', pushEvent('json_array'));
      child.on('json_object', pushEvent('json_object'));
      child.on('stderr_data', pushEvent('stderr_data'));
      child.once('exit', function(code, signal) {
        assert.equal(code, 91, 'should return child exit code');
        assert.isNotOk(signal, 'should not be killed with a signal');
        assert.deepEqual(evts, [
          [
            "stdout_line",
            "This is the multi-line stdout sentinel."
          ],
          [
            "stdout_line",
            "\rIt spans three lines."
          ],
          [
            "stdout_line",
            "It has Unix and DOS line breaks."
          ],
          [
            "json_array",
            [
              "this",
              "is",
              "the",
              "json_array",
              "sentinel"
            ]
          ],
          [
            "json_object",
            {
              "sentinel": "json_object"
            }
          ]
        ], 'should return child events in the expected order.');
        cb();
      });
    });
  });

  describe('basic abuse cases', function() {
    this.slow(3000);
    this.timeout(5000);

    // Create a superchild + shell + grandchild node process,
    // with child and grandchild processes running busy loops.
    it('should kill nested infinite loops on close()', function(cb) {
      var child = superchild('node infinite-loop-root.js', {
        cwd: path.join(__dirname, 'programs')
      });
      setTimeout(function() {
        assert.isOk(child.pid, 'should eventually have a `child.pid`');
        var pGroup = pstatus(child.pid);
        // assert.equal(pGroup.length, 3, 'should spawn 3 processes');
        _.forEach(pGroup, function(proc) {
          assert.isAtLeast(proc.rss, 1, 'should have positive RSS');
          assert.isAtLeast(proc.sz, 1, 'should have positive sz');
          assert.equal(proc.pgid, child.pid, 'should have pgid == child.pid');
        });
        child.close(function(err) {
          assert.isNotOk(err, 'should close without error');
          var pGroup = pstatus(child.pid);
          assert.strictEqual(pGroup.length, 0, 'should kill all children in process tree');
          cb();
        });
      }, 500);
    });

    // Create a superchild that exits with a nonzero error code after a delay.
    it('should handle delayed abort child programs', function(cb) {
      var child = superchild('node delayed-abort.js', {
        cwd: path.join(__dirname, 'programs')
      });
      child.on('exit', function(code, signal) {
        assert.equal(99, code, 'should return the correct exit code');
        cb();
      });
    });

  });

  describe('unlogger', function() {
    this.slow(500);

    // Ensure that unlogger is exposed, and can be used to implement a simple
    // two-way echo interaction.
    it('should be compatible with child.send()', function(cb) {
      var childOpt = {cwd: path.join(__dirname, 'programs')};
      var child = superchild('node echo.js', childOpt);
      child.send({hello: 'world'});
      child.on('json_object', function(obj) {
        assert.equal(obj.hello, 'world');
        child.close(cb);
      });
    });

    // Ensure that unlogger is exposed, and can be used to implement a simple
    // two-way echo interaction.
    it('should be able to parse "uname -a" output', function(cb) {
      var child = spawn('uname -a', {shell: true, stdio: 'pipe'});
      superchild.unlogger(child.stdout).once('stdout_line', function(unameOutput) {
        assert.isAtLeast(unameOutput.length, 3);
        cb();
      });
    });
  });

  describe('examples', function() {
    this.slow(500);

    it('should run example-1.js', function(cb) {
      var childOpt = {cwd: path.join(__dirname, 'programs')};
      var child = superchild('node example-1.js', childOpt);
      child.on('exit', function(code) {
        assert.equal(0, code);
        cb();
      });
    });

  });

});
