// A small, bounded GPU workload for the GPU admission acceptance (T-106).
// It reports the device it actually sees (UUID, as CUDA_VISIBLE_DEVICES
// selected it), holds the requested amount of GPU memory, keeps the device
// busy with a simple kernel for a fixed time, writes progress, and exits with
// a checksum. No model, no training, no network.
//
// Usage: gpu_fixture --mib N --seconds S [--progress FILE]
#include <cuda_runtime.h>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

static int fail(const char *what, cudaError_t error) {
    std::fprintf(stderr, "%s: %s\n", what, cudaGetErrorString(error));
    return 2;
}

__global__ void spin(float *data, size_t n, int rounds) {
    size_t i = blockIdx.x * (size_t)blockDim.x + threadIdx.x;
    size_t stride = (size_t)gridDim.x * blockDim.x;
    for (; i < n; i += stride) {
        float v = data[i];
        for (int r = 0; r < rounds; r++) v = v * 1.0000001f + 0.5f;
        data[i] = v;
    }
}

int main(int argc, char **argv) {
    size_t mib = 64;
    double seconds = 5;
    const char *progress = nullptr;
    for (int i = 1; i + 1 < argc; i += 2) {
        if (!std::strcmp(argv[i], "--mib")) mib = std::strtoull(argv[i + 1], nullptr, 10);
        else if (!std::strcmp(argv[i], "--seconds")) seconds = std::atof(argv[i + 1]);
        else if (!std::strcmp(argv[i], "--progress")) progress = argv[i + 1];
    }
    int count = 0;
    cudaError_t error = cudaGetDeviceCount(&count);
    // An unknown UUID in CUDA_VISIBLE_DEVICES leaves no device, reported as an error.
    if (error == cudaErrorNoDevice || (error == cudaSuccess && count < 1)) {
        std::fprintf(stderr, "no visible CUDA device\n");
        return 3;
    }
    if (error != cudaSuccess) return fail("cudaGetDeviceCount", error);
    if (count < 1) {
        std::fprintf(stderr, "no visible CUDA device\n");
        return 3;
    }
    cudaDeviceProp prop;
    if ((error = cudaGetDeviceProperties(&prop, 0)) != cudaSuccess) return fail("cudaGetDeviceProperties", error);
    char uuid[64];
    const unsigned char *u = reinterpret_cast<const unsigned char *>(prop.uuid.bytes);
    std::snprintf(uuid, sizeof uuid,
                  "GPU-%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                  u[0], u[1], u[2], u[3], u[4], u[5], u[6], u[7], u[8], u[9], u[10], u[11], u[12], u[13], u[14], u[15]);
    const char *visible = std::getenv("CUDA_VISIBLE_DEVICES");
    std::printf("{\"event\":\"device\",\"visible\":%d,\"uuid\":\"%s\",\"name\":\"%s\",\"cudaVisibleDevices\":\"%s\"}\n",
                count, uuid, prop.name, visible ? visible : "");
    std::fflush(stdout);

    size_t n = mib * 1024 * 1024 / sizeof(float);
    float *data = nullptr;
    if ((error = cudaMalloc(&data, n * sizeof(float))) != cudaSuccess) return fail("cudaMalloc", error);
    if ((error = cudaMemset(data, 0, n * sizeof(float))) != cudaSuccess) return fail("cudaMemset", error);
    auto start = std::chrono::steady_clock::now();
    long steps = 0;
    double elapsed = 0;
    while (elapsed < seconds) {
        // Short kernels, so the device is shared at kernel granularity.
        spin<<<256, 256>>>(data, n, 64);
        // A launch error (no kernel image for this GPU) is not reported by the sync.
        if ((error = cudaGetLastError()) != cudaSuccess) return fail("kernel launch", error);
        if ((error = cudaDeviceSynchronize()) != cudaSuccess) return fail("kernel", error);
        steps++;
        elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
        if (progress && steps % 20 == 0) {
            std::string tmp = std::string(progress) + ".tmp";
            if (FILE *f = std::fopen(tmp.c_str(), "w")) {
                std::fprintf(f, "{\"steps\":%ld,\"seconds\":%.2f,\"mib\":%zu}", steps, elapsed, mib);
                std::fclose(f);
                std::rename(tmp.c_str(), progress);
            }
        }
    }
    float sample = 0;
    if ((error = cudaMemcpy(&sample, data, sizeof sample, cudaMemcpyDeviceToHost)) != cudaSuccess) return fail("cudaMemcpy", error);
    cudaFree(data);
    std::printf("{\"event\":\"done\",\"steps\":%ld,\"seconds\":%.2f,\"mib\":%zu,\"sample\":%.3f}\n", steps, elapsed, mib, sample);
    return 0;
}
