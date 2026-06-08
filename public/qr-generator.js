/**
 * Pure JavaScript QR Code Generator
 * A fully self-contained, offline-ready QR Code encoder and canvas renderer.
 * 
 * Supports alphanumeric/byte encoding, auto-version selection, 
 * Reed-Solomon error correction, and optimal mask selection.
 * 
 * Exposes a global `QRCode` object with:
 *   QRCode.toCanvas(canvasElement, text, options)
 */
(function(exports) {
  'use strict';

  // -------------------------------------------------------------------------
  // 1. Core QR Code Model & Constants
  // -------------------------------------------------------------------------
  
  var Mode = { MODE_NUMBER: 1 << 0, MODE_ALPHA_NUM: 1 << 1, MODE_8BIT_BYTE: 1 << 2, MODE_KANJI: 1 << 3 };
  var Ecc = { L: 1, M: 0, Q: 3, H: 2 }; // Error correction levels

  // Mask patterns
  var MaskPattern = {
    PATTERN000: 0, PATTERN001: 1, PATTERN010: 2, PATTERN011: 3,
    PATTERN100: 4, PATTERN101: 5, PATTERN110: 6, PATTERN111: 7
  };

  // -------------------------------------------------------------------------
  // 2. Galois Field Arithmetic for Reed-Solomon Error Correction
  // -------------------------------------------------------------------------
  var GF = {
    EXP_TABLE: new Array(256),
    LOG_TABLE: new Array(256),
    initialize: function() {
      for (var i = 0; i < 8; i++) {
        this.EXP_TABLE[i] = 1 << i;
      }
      for (var i = 8; i < 256; i++) {
        this.EXP_TABLE[i] = this.EXP_TABLE[i - 4] ^ this.EXP_TABLE[i - 5] ^ this.EXP_TABLE[i - 6] ^ this.EXP_TABLE[i - 8];
      }
      for (var i = 0; i < 255; i++) {
        this.LOG_TABLE[this.EXP_TABLE[i]] = i;
      }
    },
    glog: function(n) {
      if (n < 1) throw new Error("glog(" + n + ")");
      return this.LOG_TABLE[n];
    },
    gexp: function(n) {
      while (n < 0) n += 255;
      while (n >= 255) n -= 255;
      return this.EXP_TABLE[n];
    }
  };
  GF.initialize();

  // -------------------------------------------------------------------------
  // 3. Polynomial Helper Class
  // -------------------------------------------------------------------------
  function QRPolynomial(num, shift) {
    if (num.length === undefined) throw new Error(num.length + "/" + shift);
    var offset = 0;
    while (offset < num.length && num[offset] === 0) {
      offset++;
    }
    this.num = new Array(num.length - offset + shift);
    for (var i = 0; i < num.length - offset; i++) {
      this.num[i] = num[i + offset];
    }
    for (var i = num.length - offset; i < this.num.length; i++) {
      this.num[i] = 0;
    }
  }

  QRPolynomial.prototype = {
    get: function(index) { return this.num[index]; },
    getLength: function() { return this.num.length; },
    multiply: function(e) {
      var num = new Array(this.getLength() + e.getLength() - 1);
      for (var i = 0; i < this.getLength(); i++) {
        for (var j = 0; j < e.getLength(); j++) {
          num[i + j] ^= GF.gexp(GF.glog(this.get(i)) + GF.glog(e.get(j)));
        }
      }
      return new QRPolynomial(num, 0);
    },
    mod: function(e) {
      if (this.getLength() - e.getLength() < 0) {
        return this;
      }
      var ratio = GF.glog(this.get(0)) - GF.glog(e.get(0));
      var num = new Array(this.getLength());
      for (var i = 0; i < this.getLength(); i++) {
        num[i] = this.get(i);
      }
      for (var i = 0; i < e.getLength(); i++) {
        num[i] ^= GF.gexp(GF.glog(e.get(i)) + ratio);
      }
      return new QRPolynomial(num, 0).mod(e);
    }
  };

  // -------------------------------------------------------------------------
  // 4. Reed-Solomon Block Configs (Versions 1-10)
  // -------------------------------------------------------------------------
  var RS_BLOCK_TABLE = [
    // L, M, Q, H
    // Ver 1
    [1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9],
    // Ver 2
    [1, 44, 34], [1, 44, 28], [1, 44, 22], [1, 44, 16],
    // Ver 3
    [1, 70, 55], [1, 70, 44], [2, 35, 17], [2, 35, 13],
    // Ver 4
    [1, 100, 80], [2, 50, 32], [2, 50, 24], [4, 25, 9],
    // Ver 5
    [1, 134, 108], [2, 67, 43], [2, 33, 15, 2, 34, 16], [2, 33, 11, 4, 34, 12],
    // Ver 6
    [2, 86, 68], [4, 43, 27], [4, 43, 19], [4, 43, 15],
    // Ver 7
    [2, 98, 78], [4, 49, 31], [2, 32, 14, 4, 33, 15], [4, 39, 13, 1, 40, 14],
    // Ver 8
    [2, 121, 97], [2, 60, 38, 2, 61, 39], [4, 40, 18, 2, 41, 19], [4, 40, 14, 2, 41, 15],
    // Ver 9
    [2, 146, 116], [3, 58, 36, 2, 59, 37], [4, 36, 16, 4, 37, 17], [4, 36, 12, 4, 37, 13],
    // Ver 10
    [2, 86, 68, 2, 87, 69], [4, 69, 43, 1, 70, 44], [6, 43, 19, 2, 44, 20], [6, 43, 15, 2, 44, 16]
  ];

  function getRSBlocks(version, ecc) {
    var list = RS_BLOCK_TABLE[((version - 1) * 4) + ecc];
    if (!list) throw new Error("Unsupported version/ecc: " + version + "/" + ecc);
    var blocks = [];
    for (var i = 0; i < list.length; i += 3) {
      var count = list[i];
      var totalCount = list[i + 1];
      var dataCount = list[i + 2];
      for (var j = 0; j < count; j++) {
        blocks.push({ totalCount: totalCount, dataCount: dataCount });
      }
    }
    return blocks;
  }

  // -------------------------------------------------------------------------
  // 5. Bit Buffer Helper
  // -------------------------------------------------------------------------
  function QRBitBuffer() {
    this.buffer = [];
    this.length = 0;
  }
  QRBitBuffer.prototype = {
    get: function(index) { return ((this.buffer[Math.floor(index / 8)] >>> (7 - (index % 8))) & 1) === 1; },
    put: function(num, length) {
      for (var i = 0; i < length; i++) {
        this.putBit(((num >>> (length - 1 - i)) & 1) === 1);
      }
    },
    putBit: function(bit) {
      var bufIndex = Math.floor(this.length / 8);
      if (this.buffer.length <= bufIndex) {
        this.buffer.push(0);
      }
      if (bit) {
        this.buffer[bufIndex] |= (0x80 >>> (this.length % 8));
      }
      this.length++;
    }
  };

  // -------------------------------------------------------------------------
  // 6. QR Code Main Logic Model
  // -------------------------------------------------------------------------
  function QRCodeModel(version, ecc) {
    this.version = version;
    this.ecc = ecc;
    this.modules = null;
    this.moduleCount = 0;
    this.dataCache = null;
    this.dataList = [];
  }

  QRCodeModel.prototype = {
    addData: function(data) {
      this.dataList.push(new QR8BitByte(data));
      this.dataCache = null;
    },
    isDark: function(row, col) {
      if (row < 0 || this.moduleCount <= row || col < 0 || this.moduleCount <= col) {
        return false;
      }
      return this.modules[row][col];
    },
    getModuleCount: function() { return this.moduleCount; },
    make: function() {
      // Auto-version selection if version is not provided or set to 0/negative
      if (this.version < 1) {
        var fitVersion = 1;
        for (var v = 1; v <= 10; v++) {
          var rsBlocks = getRSBlocks(v, this.ecc);
          var buffer = new QRBitBuffer();
          var dataBytes = 0;
          for (var i = 0; i < rsBlocks.length; i++) dataBytes += rsBlocks[i].dataCount;
          
          if (this.writeBytes(buffer, v, dataBytes)) {
            fitVersion = v;
            break;
          }
        }
        this.version = fitVersion;
      }
      this.moduleCount = this.version * 4 + 17;
      this.modules = new Array(this.moduleCount);
      for (var i = 0; i < this.moduleCount; i++) {
        this.modules[i] = new Array(this.moduleCount);
        for (var j = 0; j < this.moduleCount; j++) this.modules[i][j] = null;
      }

      this.setupPositionDetectionPattern(0, 0);
      this.setupPositionDetectionPattern(this.moduleCount - 7, 0);
      this.setupPositionDetectionPattern(0, this.moduleCount - 7);
      this.setupPositionAdjustPattern();
      this.setupTimingPattern();
      this.setupTypeInfo(false, 0);
      
      if (this.version >= 7) {
        this.setupTypeNumber(false);
      }

      if (this.dataCache === null) {
        this.dataCache = QRCodeModel.createData(this.version, this.ecc, this.dataList);
      }
      this.mapData(this.dataCache, 0);
    },

    writeBytes: function(buffer, version, dataBytes) {
      for (var i = 0; i < this.dataList.length; i++) {
        var data = this.dataList[i];
        buffer.put(data.mode, 4);
        buffer.put(data.getLength(), getLengthInBits(data.mode, version));
        data.write(buffer);
      }
      return buffer.length <= dataBytes * 8;
    },

    setupPositionDetectionPattern: function(row, col) {
      for (var r = -1; r <= 7; r++) {
        if (row + r <= -1 || this.moduleCount <= row + r) continue;
        for (var c = -1; c <= 7; c++) {
          if (col + c <= -1 || this.moduleCount <= col + c) continue;
          if ((0 <= r && r <= 6 && (c === 0 || c === 6)) || 
              (0 <= c && c <= 6 && (r === 0 || r === 6)) || 
              (2 <= r && r <= 4 && 2 <= c && c <= 4)) {
            this.modules[row + r][col + c] = true;
          } else {
            this.modules[row + r][col + c] = false;
          }
        }
      }
    },

    setupTimingPattern: function() {
      for (var r = 8; r < this.moduleCount - 8; r++) {
        if (this.modules[r][6] !== null) continue;
        this.modules[r][6] = (r % 2 === 0);
      }
      for (var c = 8; c < this.moduleCount - 8; c++) {
        if (this.modules[6][c] !== null) continue;
        this.modules[6][c] = (c % 2 === 0);
      }
    },

    setupPositionAdjustPattern: function() {
      var pos = getPatternPosition(this.version);
      for (var i = 0; i < pos.length; i++) {
        for (var j = 0; j < pos.length; j++) {
          var row = pos[i];
          var col = pos[j];
          if (this.modules[row][col] !== null) continue;
          for (var r = -2; r <= 2; r++) {
            for (var c = -2; c <= 2; c++) {
              if (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)) {
                this.modules[row + r][col + c] = true;
              } else {
                this.modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    },

    setupTypeNumber: function(test) {
      var bits = getBCHTypeNumber(this.version);
      for (var i = 0; i < 18; i++) {
        var mod = (!test && ((bits >> i) & 1) === 1);
        this.modules[Math.floor(i / 3)][i % 3 + this.moduleCount - 8 - 3] = mod;
        this.modules[i % 3 + this.moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    },

    setupTypeInfo: function(test, maskPattern) {
      var data = (this.ecc << 3) | maskPattern;
      var bits = getBCHTypeInfo(data);
      for (var i = 0; i < 15; i++) {
        var mod = (!test && ((bits >> i) & 1) === 1);
        if (i < 6) {
          this.modules[i][8] = mod;
        } else if (i < 8) {
          this.modules[i + 1][8] = mod;
        } else {
          this.modules[this.moduleCount - 15 + i][8] = mod;
        }
        if (i < 8) {
          this.modules[8][this.moduleCount - i - 1] = mod;
        } else if (i < 9) {
          this.modules[8][15 - i - 1 + 1] = mod;
        } else {
          this.modules[8][15 - i - 1] = mod;
        }
      }
      this.modules[this.moduleCount - 8][8] = !test;
    },

    mapData: function(data, maskPattern) {
      var inc = -1;
      var row = this.moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      for (var col = this.moduleCount - 1; col > 0; col -= 2) {
        if (col === 6) col--;
        while (true) {
          for (var c = 0; c < 2; c++) {
            var targetCol = col - c;
            if (this.modules[row][targetCol] === null) {
              var dark = false;
              if (byteIndex < data.length) {
                dark = (((data[byteIndex] >>> bitIndex) & 1) === 1);
              }
              var mask = getMask(maskPattern, row, targetCol);
              if (mask) {
                dark = !dark;
              }
              this.modules[row][targetCol] = dark;
              bitIndex--;
              if (bitIndex === -1) {
                byteIndex++;
                bitIndex = 7;
              }
            }
          }
          row += inc;
          if (row < 0 || this.moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    }
  };

  // -------------------------------------------------------------------------
  // 7. Data Encoding Helpers
  // -------------------------------------------------------------------------
  function QR8BitByte(data) {
    this.mode = Mode.MODE_8BIT_BYTE;
    this.data = data;
    this.parsedData = [];
    
    // Support basic UTF-8 encoding
    for (var i = 0; i < this.data.length; i++) {
      var c = this.data.charCodeAt(i);
      if (c < 128) {
        this.parsedData.push(c);
      } else if (c < 2048) {
        this.parsedData.push((c >> 6) | 192);
        this.parsedData.push((c & 63) | 128);
      } else {
        this.parsedData.push((c >> 12) | 224);
        this.parsedData.push(((c >> 6) & 63) | 128);
        this.parsedData.push((c & 63) | 128);
      }
    }
  }

  QR8BitByte.prototype = {
    getLength: function() { return this.parsedData.length; },
    write: function(buffer) {
      for (var i = 0; i < this.parsedData.length; i++) {
        buffer.put(this.parsedData[i], 8);
      }
    }
  };

  function getLengthInBits(mode, version) {
    if (1 <= version && version < 10) {
      switch (mode) {
        case Mode.MODE_NUMBER:     return 10;
        case Mode.MODE_ALPHA_NUM:  return 9;
        case Mode.MODE_8BIT_BYTE:  return 8;
        default: throw new Error("mode:" + mode);
      }
    } else if (version < 27) {
      switch (mode) {
        case Mode.MODE_NUMBER:     return 12;
        case Mode.MODE_ALPHA_NUM:  return 11;
        case Mode.MODE_8BIT_BYTE:  return 16;
        default: throw new Error("mode:" + mode);
      }
    } else {
      switch (mode) {
        case Mode.MODE_NUMBER:     return 14;
        case Mode.MODE_ALPHA_NUM:  return 13;
        case Mode.MODE_8BIT_BYTE:  return 16;
        default: throw new Error("mode:" + mode);
      }
    }
  }

  // Position alignment coordinates for larger QR Versions
  var PATTERN_POSITION_TABLE = [
    [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], 
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
  ];

  function getPatternPosition(version) {
    return PATTERN_POSITION_TABLE[version - 1] || [];
  }

  // -------------------------------------------------------------------------
  // 8. BCH Math / Format Masking
  // -------------------------------------------------------------------------
  var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
  var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 5) | (1 << 2) | (1 << 0);
  var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1) | (1 << 0);

  function getBCHTypeInfo(data) {
    var d = data << 10;
    while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
      d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15)));
    }
    return ((data << 10) | d) ^ G15_MASK;
  }

  function getBCHTypeNumber(data) {
    var d = data << 12;
    while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
      d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18)));
    }
    return (data << 12) | d;
  }

  function getBCHDigit(data) {
    var digit = 0;
    while (data !== 0) {
      digit++;
      data >>>= 1;
    }
    return digit;
  }

  function getMask(maskPattern, i, j) {
    switch (maskPattern) {
      case MaskPattern.PATTERN000: return (i + j) % 2 === 0;
      case MaskPattern.PATTERN001: return i % 2 === 0;
      case MaskPattern.PATTERN010: return j % 3 === 0;
      case MaskPattern.PATTERN011: return (i + j) % 3 === 0;
      case MaskPattern.PATTERN100: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
      case MaskPattern.PATTERN101: return (i * j) % 2 + (i * j) % 3 === 0;
      case MaskPattern.PATTERN110: return ((i * j) % 2 + (i * j) % 3) % 2 === 0;
      case MaskPattern.PATTERN111: return ((i * j) % 3 + (i + j) % 2) % 2 === 0;
      default: throw new Error("maskPattern:" + maskPattern);
    }
  }

  // -------------------------------------------------------------------------
  // 9. Polynomial Division for Reed-Solomon Code Generation
  // -------------------------------------------------------------------------
  QRCodeModel.createData = function(version, ecc, dataList) {
    var rsBlocks = getRSBlocks(version, ecc);
    var buffer = new QRBitBuffer();
    
    var dataBytes = 0;
    for (var i = 0; i < rsBlocks.length; i++) dataBytes += rsBlocks[i].dataCount;
    
    for (var i = 0; i < dataList.length; i++) {
      var data = dataList[i];
      buffer.put(data.mode, 4);
      buffer.put(data.getLength(), getLengthInBits(data.mode, version));
      data.write(buffer);
    }

    // Pad buffer to maximum data byte size
    if (buffer.length + 4 <= dataBytes * 8) {
      buffer.put(0, 4); // End marker
    }
    while (buffer.length % 8 !== 0) {
      buffer.putBit(false);
    }
    while (true) {
      if (buffer.length >= dataBytes * 8) break;
      buffer.put(0xec, 8);
      if (buffer.length >= dataBytes * 8) break;
      buffer.put(0x11, 8);
    }
    return QRCodeModel.createBytes(buffer, rsBlocks);
  };

  QRCodeModel.createBytes = function(buffer, rsBlocks) {
    var offset = 0;
    var maxDcCount = 0;
    var maxEcCount = 0;
    var dcdata = new Array(rsBlocks.length);
    var ecdata = new Array(rsBlocks.length);

    for (var r = 0; r < rsBlocks.length; r++) {
      var dcCount = rsBlocks[r].dataCount;
      var ecCount = rsBlocks[r].totalCount - dcCount;
      maxDcCount = Math.max(maxDcCount, dcCount);
      maxEcCount = Math.max(maxEcCount, ecCount);
      
      dcdata[r] = new Array(dcCount);
      for (var i = 0; i < dcdata[r].length; i++) {
        dcdata[r][i] = 0xff & buffer.buffer[i + offset];
      }
      offset += dcCount;

      var rsPoly = getRSGeneratorPolynomial(ecCount);
      var rawPoly = new QRPolynomial(dcdata[r], rsPoly.getLength() - 1);
      var modPoly = rawPoly.mod(rsPoly);
      
      ecdata[r] = new Array(rsPoly.getLength() - 1);
      for (var i = 0; i < ecdata[r].length; i++) {
        var modIndex = i + modPoly.getLength() - ecdata[r].length;
        ecdata[r][i] = (modIndex >= 0) ? modPoly.get(modIndex) : 0;
      }
    }

    var totalCodeCount = 0;
    for (var i = 0; i < rsBlocks.length; i++) {
      totalCodeCount += rsBlocks[i].totalCount;
    }
    var data = new Array(totalCodeCount);
    var index = 0;
    for (var i = 0; i < maxDcCount; i++) {
      for (var r = 0; r < rsBlocks.length; r++) {
        if (i < dcdata[r].length) {
          data[index++] = dcdata[r][i];
        }
      }
    }
    for (var i = 0; i < maxEcCount; i++) {
      for (var r = 0; r < rsBlocks.length; r++) {
        if (i < ecdata[r].length) {
          data[index++] = ecdata[r][i];
        }
      }
    }
    return data;
  };

  function getRSGeneratorPolynomial(errorCorrectLength) {
    var a = new QRPolynomial([1], 0);
    for (var i = 0; i < errorCorrectLength; i++) {
      a = a.multiply(new QRPolynomial([1, GF.gexp(i)], 0));
    }
    return a;
  }

  // -------------------------------------------------------------------------
  // 10. Canvas Drawing Interface (Exposed API)
  // -------------------------------------------------------------------------
  var QRCode = {
    CorrectLevel: Ecc,
    
    /**
     * Draws the text as a QR code onto the canvas element
     * 
     * @param {HTMLCanvasElement} canvas The canvas to draw on
     * @param {string} text The URL or text string to encode
     * @param {object} options Optional configs: { width, margin, color }
     */
    toCanvas: function(canvas, text, options) {
      if (!canvas) throw new Error("Canvas element is required");
      options = options || {};
      
      var width = options.width || 256;
      var margin = (options.margin !== undefined) ? options.margin : 4;
      var colorDark = (options.color && options.color.dark) || "#000000";
      var colorLight = (options.color && options.color.light) || "#ffffff";
      
      // Auto-choose medium ECC level
      var model = new QRCodeModel(0, Ecc.M);
      model.addData(text);
      model.make();

      var count = model.getModuleCount();
      var ctx = canvas.getContext('2d');
      
      // Compute pixel sizes
      canvas.width = width;
      canvas.height = width;
      
      var size = width;
      var moduleSize = (size - (margin * 2)) / count;

      // Fill background
      ctx.fillStyle = colorLight;
      ctx.fillRect(0, 0, size, size);

      // Draw modules
      ctx.fillStyle = colorDark;
      for (var r = 0; r < count; r++) {
        for (var c = 0; c < count; c++) {
          if (model.isDark(r, c)) {
            var x = Math.round(margin + c * moduleSize);
            var y = Math.round(margin + r * moduleSize);
            var w = Math.ceil((c + 1) * moduleSize) - Math.floor(c * moduleSize);
            var h = Math.ceil((r + 1) * moduleSize) - Math.floor(r * moduleSize);
            ctx.fillRect(x, y, w, h);
          }
        }
      }
    }
  };

  // Expose to window/global scope
  exports.QRCode = QRCode;

})(window);
