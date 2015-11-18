///<reference path='refs.ts'/>

module TDev.AST.Thumb
{
    interface EmitResult {
        stack: number;
        opcode: number;
        opcode2?: number;
        numArgs?: number[];
        error?: string;
        errorAt?: string;
    }

    var badNameError = emitErr("opcode name doesn't match", "<name>")

    class Instruction
    {
        public name:string;
        public args:string[];
        public friendlyFmt:string;

        constructor(format:string, public opcode:number, public mask:number)
        {
            Util.assert((opcode & mask) == opcode)

            this.friendlyFmt = format.replace(/\$\w+/g, m => {
                if (encoders[m])
                    return encoders[m].pretty
                return m
            })

            var words = tokenize(format)
            this.name = words[0]
            this.args = words.slice(1)
        }

        emit(ln:Line):EmitResult
        {
            var tokens = ln.words;
            if (tokens[0] != this.name) return badNameError;
            var r = this.opcode;
            var j = 1;
            var stack = 0;
            var numArgs = []

            for (var i = 0; i < this.args.length; ++i) {
                var formal = this.args[i]
                var actual = tokens[j++]
                if (/^\$/.test(formal)) {
                    var enc = encoders[formal]
                    var v = null
                    if (enc.isRegister) {
                        v = registerNo(actual);
                        if (v == null) return emitErr("expecting register name", actual)
                    } else if (enc.isImmediate) {
                        actual = actual.replace(/^#/, "")
                        v = ln.bin.parseOneInt(actual);
                        if (v == null) {
                            return emitErr("expecting number", actual)
                        } else {
                            if (this.opcode == 0xb000) // add sp, #imm
                                stack = -(v / 4);
                            else if (this.opcode == 0xb080) // sub sp, #imm
                                stack = (v / 4);
                        }
                    } else if (enc.isRegList) {
                        if (actual != "{") return emitErr("expecting {", actual);
                        v = 0;
                        while (tokens[j] != "}") {
                            actual = tokens[j++];
                            if (!actual)
                                return emitErr("expecting }", tokens[j - 2])
                            var no = registerNo(actual);
                            if (no == null) return emitErr("expecting register name", actual)
                            if (v & (1 << no)) return emitErr("duplicate register name", actual)
                            v |= (1 << no);
                            if (this.opcode == 0xb400) // push
                                stack++;
                            else if (this.opcode == 0xbc00) // pop
                                stack--;
                            if (tokens[j] == ",") j++;
                        }
                        actual = tokens[j++]; // skip close brace
                    } else if (enc.isLabel) {
                        actual = actual.replace(/^#/, "")
                        if (/^[+-]?\d+$/.test(actual)) {
                            v = parseInt(actual, 10)
                        } else {
                            v = ln.bin.getRelativeLabel(actual)
                            if (v == null) {
                                if (ln.bin.finalEmit)
                                    return emitErr("unknown label", actual)
                                else
                                    v = 42
                            }
                        }
                    } else {
                        Util.die()
                    }
                    if (v == null) return emitErr("didn't understand it", actual); // shouldn't happen

                    if (this.name == "bl" || this.name == "bb") {
                        if (tokens[j]) return emitErr("trailing tokens", tokens[j])
                        return this.emitBl(v, actual);
                    }

                    numArgs.push(v)
                        
                    v = enc.encode(v)
                    if (v == null) return emitErr("argument out of range or mis-aligned", actual);
                    Util.assert((r & v) == 0)
                    r |= v;
                } else if (formal == actual) {
                    // skip
                } else {
                    return emitErr("expecting " + formal, actual)
                }
            }

            if (tokens[j]) return emitErr("trailing tokens", tokens[j])

            return {
                stack: stack,
                opcode: r,
                numArgs: numArgs,
            }
        }

        private emitBl(v:number, actual:string):EmitResult
        {
            if (v % 2) return emitErr("uneven BL?", actual);
            var off = v / 2
            Util.assert(off != null)
            if ((off|0) != off ||
                // we can actually support more but the board has 256k (128k instructions)
                !(-128*1024 <= off && off <= 128*1024))
                return emitErr("jump out of range", actual);

            // note that off is already in instructions, not bytes
            var imm11 = off & 0x7ff
            var imm10 = (off >> 11) & 0x3ff

            return {
                opcode: (off & 0xf0000000) ? (0xf400 | imm10) : (0xf000 | imm10),
                opcode2: (0xf800 | imm11),
                stack: 0,
                numArgs: [v],
            }
        }

        toString()
        {
            return this.friendlyFmt;
        }
    }

    class Line
    {
        public type:string;
        public lineNo:number;
        public words:string[];

        public instruction:Instruction;
        public numArgs:number[];
        public oldText:string;

        constructor(public bin:Binary, public text:string)
        {
        }

        public getOp()
        {
            return this.instruction ? this.instruction.name : "";
        }

        public isBranch()
        {
            var op = this.getOp()
            return op == "b" || op == "bb"
        }

        public update(s:string)
        {
            if (!s) s = "; SKIP";
            if (!this.oldText) this.oldText = "";
            this.oldText += "; WAS " + this.text + "\n";
            this.text = s;
            this.instruction = null;
            this.numArgs = null;
            this.words = tokenize(s) || [];
            if (this.words.length == 0)
                this.type = "empty";
        }
    }

    export class Binary
    {
        constructor()
        {
        }

        public baseOffset:number;
        public finalEmit:boolean;
        public checkStack = true;
        public inlineMode = false;
        public lookupExternalLabel:(name:string)=>number;
        private lines:Line[];
        private currLineNo:number = 0;
        private realCurrLineNo:number;
        private currLine:Line;
        private scope = "";
        public errors:InlineError[] = [];
        public buf:number[];
        private labels:StringMap<number> = {};
        private stackpointers:StringMap<number> = {};
        private stack = 0;
        public throwOnError = false;
        public disablePeepHole = false;

        private emitShort(op:number)
        {
            Util.assert(0 <= op && op <= 0xffff);
            this.buf.push(op);
        }

        private location()
        {
            return this.buf.length * 2;
        }

        public parseOneInt(s:string)
        {
            if (!s)
                return null;

            var mul = 1
            while (m = /^([^\*]*)\*(.*)$/.exec(s)) {
                var tmp = this.parseOneInt(m[1])
                if (tmp == null) return null;
                mul *= tmp;
                s = m[2]
            }

            if (/^-/.test(s)) {
                mul *= -1;
                s = s.slice(1)
            }

            var v:number = null

            var m = /^0x([a-f0-9]+)$/i.exec(s)
            if (m) v = parseInt(m[1], 16)

            m = /^0b([01]+)$/i.exec(s)
            if (m) v = parseInt(m[1], 2)

            m = /^(\d+)$/i.exec(s)
            if (m) v = parseInt(m[1], 10)

            m = /^(\w+)@(\d+)$/.exec(s)
            if (m) {
                if (mul != 1)
                    this.directiveError(lf("multiplication not supported with saved stacks"));
                if (this.stackpointers.hasOwnProperty(m[1]))
                    v = 4 * (this.stack - this.stackpointers[m[1]] + parseInt(m[2]))
                else
                    this.directiveError(lf("saved stack not found"))
            }

            m = /^(.*)@(hi|lo)$/.exec(s)
            if (m && this.looksLikeLabel(m[1])) {
                v = this.lookupLabel(m[1], true)
                if (v != null) {
                    v >>= 1;
                    if (0 <= v && v <= 0xffff) {
                        if (m[2] == "hi")
                            v = (v >> 8) & 0xff
                        else if (m[2] == "lo")
                            v = v & 0xff
                        else
                            Util.die()
                    } else {
                        this.directiveError(lf("@hi/lo out of range"))
                        v = null
                    }
                }
            }

            if (v == null && this.looksLikeLabel(s)) {
                v = this.lookupLabel(s, true);
                v += this.baseOffset;
            }

            if (v == null || isNaN(v)) return null;

            return v * mul;
        }

        private looksLikeLabel(name:string)
        {
            if (/^(r\d|pc|sp|lr)$/i.test(name))
                return false
            return /^[\.a-zA-Z_][\.\w+]*$/.test(name)
        }

        private scopedName(name:string)
        {
            if (name[0] == "." && this.scope)
                return this.scope + "$" + name;
            else return name;
        }

        private lookupLabel(name:string, direct = false)
        {
            var v = null;
            var scoped = this.scopedName(name)
            if (this.labels.hasOwnProperty(scoped))
                v = this.labels[scoped];
            else if (this.lookupExternalLabel)
                v = this.lookupExternalLabel(name)
            if (v == null && direct) {
                if (this.finalEmit)
                    this.directiveError(lf("unknown label: {0}", name));
                else
                    v = 42;
            }
            return v;
        }

        public getRelativeLabel(s:string)
        {
            var l = this.lookupLabel(s);
            if (l == null) return null;
            return l - (this.location() + 4);
        }

        private align(n:number)
        {
            Util.assert(n == 2 || n == 4 || n == 8 || n == 16)
            while (this.location() % n != 0)
                this.emitShort(0);
        }

        public pushError(msg:string, hints:string = "")
        {
            var err = <InlineError>{
                scope: this.scope,
                message: lf("  -> Line {2} ('{1}'), error: {0}\n{3}", msg, this.currLine.text, this.currLine.lineNo, hints),
                lineNo: this.currLine.lineNo,
                line: this.currLine.text,
                coremsg: msg,
                hints: hints
            }
            this.errors.push(err)
            if (this.throwOnError)
                throw new Error(err.message)
        }

        private directiveError(msg:string)
        {
            this.pushError(msg)
            // this.pushError(lf("directive error: {0}", msg))
        }

        private emitString(l:string)
        {
            function byteAt(s:string, i:number) { return (s.charCodeAt(i) || 0) & 0xff }

            var m = /^\s*([\w\.]+\s*:\s*)?.\w+\s+(".*")\s*$/.exec(l)
            var s:string;
            if (!m || null == (s = parseString(m[2]))) {
                this.directiveError(lf("expecting string"))
            } else {
                this.align(2);
                // s.length + 1 to NUL terminate
                for (var i = 0; i < s.length + 1; i += 2) {
                    this.emitShort( (byteAt(s, i+1) << 8) | byteAt(s, i) )
                }
            }
        }

        private parseNumber(words:string[]):number
        {
            var v = this.parseOneInt(words.shift())
            if (v == null) return null;
            return v;
        }

        private parseNumbers(words:string[])
        {
            words = words.slice(1)
            var nums:number[] = []
            while (true) {
                var n = this.parseNumber(words)
                if (n == null) {
                    this.directiveError(lf("cannot parse number at '{0}'", words[0]))
                    break;
                } else
                    nums.push(n)

                if (words[0] == ",") {
                    words.shift()
                    if (words[0] == null)
                        break;
                } else if (words[0] == null) {
                    break;
                } else {
                    this.directiveError(lf("expecting number, got '{0}'", words[0]))
                    break;
                }
            }
            return nums
        }

        private emitSpace(words:string[])
        {
            var nums = this.parseNumbers(words);
            if (nums.length == 1)
                nums.push(0)
            if (nums.length != 2)
                this.directiveError(lf("expecting one or two numbers"))
            else if (nums[0] % 2 != 0)
                this.directiveError(lf("only even space supported"))
            else {
                var f = nums[1] & 0xff;
                f = f | (f << 8)
                for (var i = 0; i < nums[0]; i += 2)
                    this.emitShort(f)
            }
        }

        private emitBytes(words:string[])
        {
            var nums = this.parseNumbers(words)
            if (nums.length % 2 != 0) {
                this.directiveError(".bytes needs an even number of arguments")
                nums.push(0)
            }
            for (var i = 0; i < nums.length; i += 2) {
                var n0 = nums[i]
                var n1 = nums[i+1]
                if (0 <= n0 && n1 <= 0xff &&
                    0 <= n1 && n0 <= 0xff)
                    this.emitShort((n0&0xff) | ((n1&0xff) << 8))
                else
                    this.directiveError(lf("expecting uint8"))
            }
        }
        
        private handleDirective(l:Line)
        {
            var words = l.words;

            var expectOne = () => {
                if (words.length != 2)
                    this.directiveError(lf("expecting one argument"));
            }

            var num0:number;

            switch (words[0]) {
                case ".ascii":
                case ".asciz":
                case ".string":
                    this.emitString(l.text);
                    break;
                case ".align":
                    expectOne();
                    num0 = this.parseOneInt(words[1]);
                    if (num0 != null) {
                        if (num0 == 0) return;
                        if (num0 <= 4) {
                            this.align(1 << num0);
                        } else {
                            this.directiveError(lf("expecting 1, 2, 3 or 4 (for 2, 4, 8, or 16 byte alignment)"))
                        }
                    } else this.directiveError(lf("expecting number"));
                    break;
                case ".balign":
                    expectOne();
                    num0 = this.parseOneInt(words[1]);
                    if (num0 != null) {
                        if (num0 == 1) return;
                        if (num0 == 2 || num0 == 4 || num0 == 8 || num0 == 16) {
                            this.align(num0);
                        } else {
                            this.directiveError(lf("expecting 2, 4, 8, or 16"))
                        }
                    } else this.directiveError(lf("expecting number"));
                    break;
                case ".byte":
                    this.emitBytes(words);
                    break;
                case ".hword":
                case ".short":
                case ".2bytes":
                    this.parseNumbers(words).forEach(n => {
                        // we allow negative numbers
                        if (-0x8000 <= n && n <= 0xffff)
                            this.emitShort(n & 0xffff)
                        else
                            this.directiveError(lf("expecting int16"))
                    })
                    break;
                case ".word":
                case ".4bytes":
                    this.parseNumbers(words).forEach(n => {
                        // we allow negative numbers
                        if (-0x80000000 <= n && n <= 0xffffffff) {
                            this.emitShort(n & 0xffff)
                            this.emitShort((n >> 16) & 0xffff)
                        } else {
                            this.directiveError(lf("expecting int32"))
                        }
                    })
                    break;

                case ".skip":
                case ".space":
                    this.emitSpace(words);
                    break;

                // The usage for this is as follows:
                // push {...}
                // @stackmark locals   ; locals := sp
                // ... some push/pops ...
                // ldr r0, [pc, locals@3] ; load local number 3
                // ... some push/pops ...
                // @stackempty locals ; expect an empty stack here
                case "@stackmark":
                    expectOne();
                    this.stackpointers[words[1]] = this.stack;
                    break;

                case "@stackempty":
                    if (this.stackpointers[words[1]] == null)
                        this.directiveError(lf("no such saved stack"))
                    else if (this.stackpointers[words[1]] != this.stack)
                        this.directiveError(lf("stack mismatch"))
                    break;

                case "@scope":
                    this.scope = words[1] || "";
                    this.currLineNo = this.scope ? 0 : this.realCurrLineNo;
                    break;

                case ".section":
                case ".global":
                    this.stackpointers = {};
                    this.stack = 0;
                    break;

                case ".file":
                case ".text":
                case ".cpu":
                case ".fpu":
                case ".eabi_attribute":
                case ".code":
                case ".thumb_func":
                case ".type":
                    break;

                case "@":
                    // @ sp needed
                    break;

                default:
                    if (/^\.cfi_/.test(words[0])) {
                        // ignore
                    } else {
                        this.directiveError(lf("unknown directive"))
                    }
                    break;
            }
        }

        private handleInstruction(ln:Line)
        {
            var getIns = n => instructions.hasOwnProperty(n) ? instructions[n] : [];

            var ins = ln.instruction ? [ln.instruction] : getIns(ln.words[0])
            for (var i = 0; i < ins.length; ++i) {
                var op = ins[i].emit(ln);
                if (!op.error) {
                    this.stack += op.stack;
                    if (this.checkStack && this.stack < 0)
                        this.pushError(lf("stack underflow"))
                    this.emitShort(op.opcode);
                    if (op.opcode2 != null)
                        this.emitShort(op.opcode2);
                    ln.instruction = ins[i];
                    ln.numArgs = op.numArgs;
                    return;
                }
            }

            var w0 = ln.words[0].toLowerCase().replace(/s$/, "").replace(/[^a-z]/g, "")

            var hints = ""
            var possibilities = getIns(w0).concat(getIns(w0 + "s"))
            if (possibilities.length > 0) {
                possibilities.forEach(i => {
                    var err = i.emit(ln);
                    hints += lf("   Maybe: {0} ({1} at '{2}')\n", i.toString(), err.error, err.errorAt)
                })
            }

            this.pushError(lf("assembly error"), hints);
        }

        private mkLine(tx:string)
        {
            var l = new Line(this, tx);
            l.lineNo = this.currLineNo;
            this.lines.push(l);
            return l;
        }

        private prepLines(text:string)
        {
            this.currLineNo = 0;
            this.realCurrLineNo = 0;
            this.lines = [];

            text.split(/\r?\n/).forEach(tx => {
                if (this.errors.length > 10)
                    return;

                this.currLineNo++;
                this.realCurrLineNo++;

                var l = this.mkLine(tx);
                var words = tokenize(l.text) || [];
                l.words = words;

                var m = /^([\.\w]+):$/.exec(words[0])

                if (m) {
                    l.type = "label";
                    l.text = m[1] + ":"
                    l.words = [m[1]]
                    if (words.length > 1) {
                        words.shift()
                        l = this.mkLine(tx.replace(/^[^:]*:/, ""))
                        l.words = words
                    } else {
                        return;
                    }
                }

                if (/^[\.@]/.test(l.words[0])) {
                    l.type = "directive";
                    if (l.words[0] == "@scope")
                        this.handleDirective(l);
                } else {
                    if (l.words.length == 0)
                        l.type = "empty";
                    else
                        l.type = "instruction";
                }
            })
        }

        private iterLines()
        {
            this.stack = 0;
            this.buf = [];
            this.lines.forEach(l => {
                if (this.errors.length > 10)
                    return;

                this.currLine = l;

                if (l.words.length == 0) return;

                if (l.type == "label") {
                    var lblname = this.scopedName(l.words[0])
                    if (this.finalEmit) {
                        var curr = this.labels[lblname]
                        if (curr == null)
                            Util.die()
                        Util.assert(this.errors.length > 0 || curr == this.location())
                    } else {
                        if (this.labels.hasOwnProperty(lblname))
                            this.directiveError(lf("label redefinition"))
                        else if (this.inlineMode && /^_/.test(lblname))
                            this.directiveError(lf("labels starting with '_' are reserved for the compiler"))
                        else
                            this.labels[lblname] = this.location();
                    }
                } else if (l.type == "directive") {
                    this.handleDirective(l);
                } else if (l.type == "instruction") {
                    this.handleInstruction(l);
                } else if (l.type == "empty") {
                    // nothing
                } else {
                    Util.die()
                }

            })
        }

        public getSource()
        {
            var lenTotal = this.buf ? this.buf.length*2 : 0
            var lenThumb = this.labels["_program_end"] || lenTotal;
            var res = 
                Util.fmt("; thumb size: {0} bytes; src size {1} bytes\n", lenThumb, lenTotal - lenThumb) + 
                Util.fmt("; assembly: {0} lines\n", this.lines.length)

            var pastEnd = false;

            this.lines.forEach(ln => {
                if (pastEnd) return;
                if (ln.type == "label" && ln.words[0] == "_program_end")
                    pastEnd = true;
                if (ln.oldText)
                    res += ln.oldText;
                res += ln.text + "\n"
            })

            return res;
        }

        private peepHole()
        {
            // TODO disable in user scope
            
            var lb11 = encoders["$lb11"]
            var lb = encoders["$lb"]

            for (var i = 0; i < this.lines.length; ++i) {
                var ln = this.lines[i];
                var lnNext = this.lines[i + 1];
                if (!lnNext) continue;
                if (ln.type == "instruction") {
                    if (ln.getOp() == "bb" && lb11.encode(ln.numArgs[0]) != null) {
                        ln.update("b " + ln.words[1])
                    } else if (ln.getOp() == "bne" && lnNext.isBranch() && lb.encode(lnNext.numArgs[0]) != null) {
                        ln.update("beq " + lnNext.words[1])
                        lnNext.update("")
                    } else if (ln.getOp() == "beq" && lnNext.isBranch() && lb.encode(lnNext.numArgs[0]) != null) {
                        ln.update("bne " + lnNext.words[1])
                        lnNext.update("")
                    } else if (ln.getOp() == "push" && lnNext.getOp() == "pop" && ln.numArgs[0] == lnNext.numArgs[0]) {
                        Util.assert(ln.numArgs[0] > 0)
                        ln.update("")
                        lnNext.update("")
                    } else if (ln.getOp() == "push" && lnNext.getOp() == "pop" && 
                               ln.words.length == 4 && 
                               lnNext.words.length == 4) {
                        Util.assert(ln.words[1] == "{")
                        ln.update("mov " + lnNext.words[2] + ", " + ln.words[2])
                        lnNext.update("")
                    }
                }
            }
        }

        private peepPass()
        {
            if (this.disablePeepHole)
                return;

            this.peepHole();

            this.throwOnError = true;
            this.finalEmit = false;
            this.labels = {};
            this.iterLines();
            Util.assert(!this.checkStack || this.stack == 0);
            this.finalEmit = true;
            this.iterLines();
        }

        public emit(text:string)
        {
            init();

            Util.assert(this.buf == null);

            this.prepLines(text);

            if (this.errors.length > 0)
                return;

            this.labels = {};
            this.iterLines();

            if (this.checkStack && this.stack != 0)
                this.directiveError(lf("stack misaligned at the end of the file"))

            if (this.errors.length > 0)
                return;

            this.finalEmit = true;
            this.iterLines();

            if (this.errors.length > 0)
                return;

            this.peepPass();
            this.peepPass();
        }
    }

    function registerNo(actual:string)
    {
        if (!actual) return null;
        actual = actual.toLowerCase()
        switch (actual) {
            case "pc": actual = "r15"; break;
            case "lr": actual = "r14"; break;
            case "sp": actual = "r13"; break;
        }
        var m = /^r(\d+)$/.exec(actual)
        if (m) {
            var r = parseInt(m[1], 10)
            if (0 <= r && r < 16)
                return r;
        }
        return null;
    }

    interface Encoder {
        name: string;
        pretty: string;
        encode: (v:number) => number;
        isRegister: boolean;
        isImmediate: boolean;
        isRegList: boolean;
        isLabel: boolean;
    }

    var instructions:StringMap<Instruction[]>;
    var encoders:StringMap<Encoder>;

    function tokenize(line:string):string[]
    {
        line = line.replace(/[\[\]\!\{\},]/g, m => " " + m + " ")
        var words = line.split(/\s/).filter(s => !!s)
        if (!words[0]) return null
        if (/^;/.test(words[0])) return null
        for (var i = 1; i < words.length; ++i) {
            if (/^;/.test(words[i]))
                return words.slice(0, i);
        }
        return words
    }
    
    function init()
    {
        if (instructions) return;

        encoders = {};
        var addEnc = (n:string, p:string, e:(v:number) => number) => {
            var ee = { 
                name:n, 
                pretty:p, 
                encode:e, 
                isRegister: /^\$r\d/.test(n), 
                isImmediate: /^\$i\d/.test(n),
                isRegList: /^\$rl\d/.test(n),
                isLabel: /^\$l[a-z]/.test(n),
            }
            encoders[n] = ee
            return ee
        }

        var inrange = (max:number, v:number, e:number) => {
            if (Math.floor(v) != v) return null;
            if (v < 0) return null;
            if (v > max) return null;
            return e;
        }

        // Registers
        // $r0 - bits 2:1:0
        // $r1 - bits 5:4:3
        // $r2 - bits 7:2:1:0
        // $r3 - bits 6:5:4:3
        // $r4 - bits 8:7:6
        // $r5 - bits 10:9:8

        addEnc("$r0", "R0-7", v => inrange(7, v, v))
        addEnc("$r1", "R0-7", v => inrange(7, v, v << 3))
        addEnc("$r2", "R0-15", v => inrange(15, v, (v & 7) | ((v & 8) << 4)))
        addEnc("$r3", "R0-15", v => inrange(15, v, v << 3))
        addEnc("$r4", "R0-7", v => inrange(7, v, v << 6))
        addEnc("$r5", "R0-7", v => inrange(7, v, v << 8))

        // Immdiates:
        // $i0 - bits 7-0
        // $i1 - bits 7-0 * 4
        // $i2 - bits 6-0 * 4
        // $i3 - bits 8-6
        // $i4 - bits 10-6
        // $i5 - bits 10-6 * 4
        // $i6 - bits 10-6, 0 is 32
        // $i7 - bits 10-6 * 2

        addEnc("$i0", "#0-255", v => inrange(255, v, v))
        addEnc("$i1", "#0-1020", v => inrange(255, v/4, v >> 2))
        addEnc("$i2", "#0-510", v => inrange(127, v/4, v >> 2))
        addEnc("$i3", "#0-7", v => inrange(7, v, v << 6))
        addEnc("$i4", "#0-31", v => inrange(31, v, v << 6))
        addEnc("$i5", "#0-124", v => inrange(31, v/4, (v >> 2) << 6))
        addEnc("$i6", "#1-32", v => v == 0 ? null : v == 32 ? 0 : inrange(31, v, v << 6))
        addEnc("$i7", "#0-62", v => inrange(31, v/2, (v >> 1) << 6))

        addEnc("$rl0", "{R0-7,...}", v => inrange(255, v, v))
        addEnc("$rl1", "{LR,R0-7,...}", v => (v & 0x4000) ? inrange(255, (v & ~0x4000), 0x100 | (v&0xff)) : inrange(255, v, v))
        addEnc("$rl2", "{PC,R0-7,...}", v => (v & 0x8000) ? inrange(255, (v & ~0x8000), 0x100 | (v&0xff)) : inrange(255, v, v))

        var inrangeSigned = (max:number, v:number, e:number) => {
            if (Math.floor(v) != v) return null;
            if (v < -(max+1)) return null;
            if (v > max) return null;
            var mask = (max << 1) | 1
            return e & mask;
        }

        addEnc("$la", "LABEL", v => inrange(255, v/4, v >> 2))
        addEnc("$lb", "LABEL", v => inrangeSigned(127, v/2, v >> 1))
        addEnc("$lb11", "LABEL", v => inrangeSigned(1023, v/2, v >> 1))

        instructions = {}
        var add = (name, code, mask) => {
            var ins = new Instruction(name, code, mask)
            if (!instructions.hasOwnProperty(ins.name))
                instructions[ins.name] = [];
            instructions[ins.name].push(ins)
        }

        //add("nop",                   0xbf00, 0xffff);  // we use mov r8,r8 as gcc

        add("adcs  $r0, $r1",        0x4140, 0xffc0);
        add("add   $r2, $r3",        0x4400, 0xff00);
        add("add   $r5, pc, $i1",    0xa000, 0xf800);
        add("add   $r5, sp, $i1",    0xa800, 0xf800);
        add("add   sp, $i2",         0xb000, 0xff80);
        add("adds  $r0, $r1, $i3",   0x1c00, 0xfe00);
        add("adds  $r0, $r1, $r4",   0x1800, 0xfe00);
        add("adds  $r5, $i0",        0x3000, 0xf800);
        add("adr   $r5, $la",        0xa000, 0xf800);
        add("ands  $r0, $r1",        0x4000, 0xffc0);
        add("asrs  $r0, $r1",        0x4100, 0xffc0);
        add("asrs  $r0, $r1, $i6",   0x1000, 0xf800);
        add("bics  $r0, $r1",        0x4380, 0xffc0);
        add("bkpt  $i0",             0xbe00, 0xff00);
        add("blx   $r3",             0x4780, 0xff87);
        add("bx    $r3",             0x4700, 0xff80);
        add("cmn   $r0, $r1",        0x42c0, 0xffc0);
        add("cmp   $r0, $r1",        0x4280, 0xffc0);
        add("cmp   $r2, $r3",        0x4500, 0xff00);
        add("cmp   $r5, $i0",        0x2800, 0xf800);
        add("eors  $r0, $r1",        0x4040, 0xffc0);
        add("ldmia $r5!, $rl0",      0xc800, 0xf800);
        add("ldmia $r5, $rl0",       0xc800, 0xf800);
        add("ldr   $r0, [$r1, $i5]", 0x6800, 0xf800);
        add("ldr   $r0, [$r1, $r4]", 0x5800, 0xfe00);
        add("ldr   $r5, [pc, $i1]",  0x4800, 0xf800);
        //add("ldr   $r5, $la",        0x4800, 0xf800);
        add("ldr   $r5, [sp, $i1]",  0x9800, 0xf800);
        add("ldrb  $r0, [$r1, $i4]", 0x7800, 0xf800);
        add("ldrb  $r0, [$r1, $r4]", 0x5c00, 0xfe00);
        add("ldrh  $r0, [$r1, $i7]", 0x8800, 0xf800);
        add("ldrh  $r0, [$r1, $r4]", 0x5a00, 0xfe00);
        add("ldrsb $r0, [$r1, $r4]", 0x5600, 0xfe00);
        add("ldrsh $r0, [$r1, $r4]", 0x5e00, 0xfe00);
        add("lsls  $r0, $r1",        0x4080, 0xffc0);
        add("lsls  $r0, $r1, $i4",   0x0000, 0xf800);
        add("lsrs  $r0, $r1",        0x40c0, 0xffc0);
        add("lsrs  $r0, $r1, $i6",   0x0800, 0xf800);
        add("mov   $r0, $r1",        0x4600, 0xffc0);
        //add("mov   $r2, $r3",        0x4600, 0xff00);
        add("movs  $r0, $r1",        0x0000, 0xffc0);
        add("movs  $r5, $i0",        0x2000, 0xf800);
        add("muls  $r0, $r1",        0x4340, 0xffc0);
        add("mvns  $r0, $r1",        0x43c0, 0xffc0);
        add("negs  $r0, $r1",        0x4240, 0xffc0);
        add("nop",                   0x46c0, 0xffff); // mov r8, r8
        add("orrs  $r0, $r1",        0x4300, 0xffc0);
        add("pop   $rl2",            0xbc00, 0xfe00);
        add("push  $rl1",            0xb400, 0xfe00);
        add("rev   $r0, $r1",        0xba00, 0xffc0);
        add("rev16 $r0, $r1",        0xba40, 0xffc0);
        add("revsh $r0, $r1",        0xbac0, 0xffc0);
        add("rors  $r0, $r1",        0x41c0, 0xffc0);
        add("sbcs  $r0, $r1",        0x4180, 0xffc0);
        add("sev",                   0xbf40, 0xffff);
        add("stmia $r5!, $rl0",      0xc000, 0xf800);
        add("str   $r0, [$r1, $i5]", 0x6000, 0xf800);
        add("str   $r0, [$r1, $r4]", 0x5000, 0xfe00);
        add("str   $r5, [sp, $i1]",  0x9000, 0xf800);
        add("strb  $r0, [$r1, $i4]", 0x7000, 0xf800);
        add("strb  $r0, [$r1, $r4]", 0x5400, 0xfe00);
        add("strh  $r0, [$r1, $i7]", 0x8000, 0xf800);
        add("strh  $r0, [$r1, $r4]", 0x5200, 0xfe00);
        add("sub   sp, $i2",         0xb080, 0xff80);
        add("subs  $r0, $r1, $i3",   0x1e00, 0xfe00);
        add("subs  $r0, $r1, $r4",   0x1a00, 0xfe00);
        add("subs  $r5, $i0",        0x3800, 0xf800);
        add("svc   $i0",             0xdf00, 0xff00);
        add("sxtb  $r0, $r1",        0xb240, 0xffc0);
        add("sxth  $r0, $r1",        0xb200, 0xffc0);
        add("tst   $r0, $r1",        0x4200, 0xffc0);
        add("udf   $i0",             0xde00, 0xff00);
        add("uxtb  $r0, $r1",        0xb2c0, 0xffc0);
        add("uxth  $r0, $r1",        0xb280, 0xffc0);
        add("wfe",                   0xbf20, 0xffff);
        add("wfi",                   0xbf30, 0xffff);
        add("yield",                 0xbf10, 0xffff);

        add("beq   $lb",             0xd000, 0xff00);
        add("bne   $lb",             0xd100, 0xff00);
        add("bcs   $lb",             0xd200, 0xff00);
        add("bcc   $lb",             0xd300, 0xff00);
        add("bmi   $lb",             0xd400, 0xff00);
        add("bpl   $lb",             0xd500, 0xff00);
        add("bvs   $lb",             0xd600, 0xff00);
        add("bvc   $lb",             0xd700, 0xff00);
        add("bhi   $lb",             0xd800, 0xff00);
        add("bls   $lb",             0xd900, 0xff00);
        add("bge   $lb",             0xda00, 0xff00);
        add("blt   $lb",             0xdb00, 0xff00);
        add("bgt   $lb",             0xdc00, 0xff00);
        add("ble   $lb",             0xdd00, 0xff00);
        add("bhs   $lb",             0xd200, 0xff00); // cs
        add("blo   $lb",             0xd300, 0xff00); // cc

        add("b     $lb11",           0xe000, 0xf800);
        add("bal   $lb11",           0xe000, 0xf800);

        // handled specially - 32 bit instruction
        add("bl    $lb",             0xf000, 0xf800);
        // this is normally emitted as 'b' but will be emitted as 'bl' if needed
        add("bb    $lb",             0xe000, 0xf800);
    }

    function parseString(s:string)
    {
        var toks = AST.Lexer.tokenize(s)
        if (toks.length != 2 ||
            toks[0].category != AST.TokenType.String ||
            toks[1].category != AST.TokenType.EOF)
            return null
        return toks[0].data
    }

    function emitErr(msg:string, tok:string)
    {
        return {
            stack: null,
            opcode: null,
            error: msg,
            errorAt: tok
        }
    }

    export function testOne(op:string, code:number)
    {
        var b = new Binary()
        b.checkStack = false;
        b.emit(op)
        Util.assert(b.buf[0] == code)
    }

    function expectError(asm:string)
    {
        var b = new Binary();
        b.emit(asm);
        if (b.errors.length == 0) {
            Util.oops("ASMTEST: expecting error for: " + asm)
        }
        // console.log(b.errors[0].message)
    }

    export function tohex(n:number)
    {
        if (n < 0 || n > 0xffff)
            return ("0x" + n.toString(16)).toLowerCase()
        else
            return ("0x" + ("000" + n.toString(16)).slice(-4)).toLowerCase()
    }

    function expect(disasm:string)
    {
        var exp = []
        var asm = disasm.replace(/^([0-9a-fA-F]{4})\s/gm, (w, n) => {
            exp.push(parseInt(n, 16))
            return ""
        })

        var b = new Binary();
        b.throwOnError = true;
        b.disablePeepHole = true;
        b.emit(asm);
        if (b.errors.length > 0) {
            console.log(b.errors[0].message)
            Util.oops("ASMTEST: not expecting errors")
        }

        if (b.buf.length != exp.length)
            Util.oops("ASMTEST: wrong buf len")
        for (var i = 0; i < exp.length; ++i) {
            if (b.buf[i] != exp[i])
                Util.oops("ASMTEST: wrong buf content, exp:" + tohex(exp[i]) + ", got: " + tohex(b.buf[i]))
        }
    }

    export function test()
    {
        expectError("lsl r0, r0, #8");
        expectError("push {pc,lr}");
        expectError("push {r17}");
        expectError("mov r0, r1 foo");
        expectError("movs r14, #100");
        expectError("push {r0");
        expectError("push lr,r0}");
        expectError("pop {lr,r0}");
        expectError("b #+11");
        expectError("b #+102400");
        expectError("bne undefined_label");
        expectError(".foobar");

        expect(
            "0200      lsls    r0, r0, #8\n" +
            "b500      push    {lr}\n" +
            "2064      movs    r0, #100        ; 0x64\n" +
            "b401      push    {r0}\n" +
            "bc08      pop     {r3}\n" +
            "b501      push    {r0, lr}\n" +
            "bd20      pop {r5, pc}\n" +
            "bc01      pop {r0}\n" +
            "4770      bx      lr\n" +
            "0000      .balign 4\n" +
            "e6c0      .word   -72000\n" +
            "fffe\n" )

        expect(
            "4291      cmp     r1, r2\n" +
            "d100      bne     l6\n" +
            "e000      b       l8\n" +
            "1840  l6: adds    r0, r0, r1\n" +
            "4718  l8: bx      r3\n")

        expect(
            "          @stackmark base\n" +
            "b403      push    {r0, r1}\n" +
            "          @stackmark locals\n" +
            "9801      ldr     r0, [sp, locals@1]\n" +
            "b401      push    {r0}\n" +
            "9802      ldr     r0, [sp, locals@1]\n" +
            "bc01      pop     {r0}\n" +
            "          @stackempty locals\n" +
            "9901      ldr     r1, [sp, locals@1]\n" +
            "9102      str     r1, [sp, base@0]\n" +
            "          @stackempty locals\n" +
            "b002      add     sp, #8\n" +
            "          @stackempty base\n")

        expect(
            "b090      sub sp, #4*16\n" +
            "b010      add sp, #4*16\n" 
            )

        expect(
            "6261      .string \"abc\"\n" +
            "0063      \n" 
            )

        expect(
            "6261      .string \"abcde\"\n" +
            "6463      \n"  +
            "0065      \n" 
            )

        expect(
            "3042      adds r0, 0x42\n" +
            "1c0d      adds r5, r1, #0\n" +
            "d100      bne #0\n" +
            "2800      cmp r0, #0\n" +
            "6b28      ldr r0, [r5, #48]\n" +
            "0200      lsls r0, r0, #8\n" +
            "2063      movs r0, 0x63\n" +
            "4240      negs r0, r0\n" +
            "46c0      nop\n" +
            "b500      push {lr}\n" +
            "b401      push {r0}\n" +
            "b402      push {r1}\n" +
            "b404      push {r2}\n" +
            "b408      push {r3}\n" +
            "b520      push {r5, lr}\n" +
            "bd00      pop {pc}\n" +
            "bc01      pop {r0}\n" +
            "bc02      pop {r1}\n" +
            "bc04      pop {r2}\n" +
            "bc08      pop {r3}\n" +
            "bd20      pop {r5, pc}\n" +
            "9003      str r0, [sp, #4*3]\n")
    }

}
