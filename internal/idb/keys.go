package idb

// USB HID keyboard usages (page 7).
const (
	KeyEnter     = 40
	KeyEscape    = 41
	KeyBackspace = 42
	KeyTab       = 43
	KeyRight     = 79
	KeyLeft      = 80
	KeyDown      = 81
	KeyUp        = 82
	KeyLeftShift = 225
)

var symbols = map[rune]struct {
	code  uint64
	shift bool
}{
	' ': {44, false}, '\n': {KeyEnter, false}, '\t': {KeyTab, false},
	'-': {45, false}, '_': {45, true}, '=': {46, false}, '+': {46, true},
	'[': {47, false}, '{': {47, true}, ']': {48, false}, '}': {48, true},
	'\\': {49, false}, '|': {49, true}, ';': {51, false}, ':': {51, true},
	'\'': {52, false}, '"': {52, true}, '`': {53, false}, '~': {53, true},
	',': {54, false}, '<': {54, true}, '.': {55, false}, '>': {55, true},
	'/': {56, false}, '?': {56, true},
	'!': {30, true}, '@': {31, true}, '#': {32, true}, '$': {33, true}, '%': {34, true},
	'^': {35, true}, '&': {36, true}, '*': {37, true}, '(': {38, true}, ')': {39, true},
}

func KeyFor(r rune) (code uint64, shift, ok bool) {
	switch {
	case r >= 'a' && r <= 'z':
		return uint64(4 + r - 'a'), false, true
	case r >= 'A' && r <= 'Z':
		return uint64(4 + r - 'A'), true, true
	case r >= '1' && r <= '9':
		return uint64(30 + r - '1'), false, true
	case r == '0':
		return 39, false, true
	}
	s, ok := symbols[r]
	return s.code, s.shift, ok
}
