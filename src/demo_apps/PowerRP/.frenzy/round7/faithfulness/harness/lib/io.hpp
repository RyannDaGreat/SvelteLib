// THE C++ HALF OF THE WIRE between an upstream DSP kernel and ours.
//
// Both sides read the SAME interleaved float32 input file and write an
// interleaved float32 output file. Sharing the input file rather than
// regenerating it on each side removes a whole class of false difference:
// a harness that computed its own sine on each side would be measuring its
// own two sine generators as much as the DSP under test.
//
// float32, not float64, because that is what a VCV Rack port carries between
// modules and what our engine carries; a float64 wire would report a precision
// the real signal path does not have.
#pragma once

#include <cstdio>
#include <cstdlib>
#include <vector>
#include <string>

namespace ab {

// Query. Read a whole interleaved float32 file. Aborts loudly on any failure:
// a harness that silently returned an empty buffer would report perfect
// agreement between two silences.
inline std::vector<float> readF32(const std::string& path) {
	FILE* f = fopen(path.c_str(), "rb");
	if (!f) { fprintf(stderr, "readF32: cannot open %s\n", path.c_str()); exit(2); }
	fseek(f, 0, SEEK_END);
	long bytes = ftell(f);
	fseek(f, 0, SEEK_SET);
	if (bytes < 0 || bytes % 4 != 0) { fprintf(stderr, "readF32: %s is %ld bytes, not a whole number of floats\n", path.c_str(), bytes); exit(2); }
	std::vector<float> out((size_t)(bytes / 4));
	if (out.size() && fread(out.data(), 4, out.size(), f) != out.size()) { fprintf(stderr, "readF32: short read on %s\n", path.c_str()); exit(2); }
	fclose(f);
	return out;
}

// Command. Write an interleaved float32 file. Aborts loudly on failure.
inline void writeF32(const std::string& path, const std::vector<float>& data) {
	FILE* f = fopen(path.c_str(), "wb");
	if (!f) { fprintf(stderr, "writeF32: cannot open %s\n", path.c_str()); exit(2); }
	if (data.size() && fwrite(data.data(), 4, data.size(), f) != data.size()) { fprintf(stderr, "writeF32: short write on %s\n", path.c_str()); exit(2); }
	fclose(f);
}

// Query. argv[i] as a double, or abort. No default: a case that silently used
// 0 for a mistyped cutoff would produce a plausible-looking wrong answer.
inline double argD(int argc, char** argv, int i, const char* name) {
	if (i >= argc) { fprintf(stderr, "missing argument %d (%s)\n", i, name); exit(2); }
	return atof(argv[i]);
}

} // namespace ab
