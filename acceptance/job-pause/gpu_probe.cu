// A small, checkable CUDA workload for the T-107 pause probe.
//
//   gpu_probe NAME STATE_DIR SECONDS MIB KERNEL_MS QUEUE [ROUNDS]
//
// Repeats one kernel over a MIB-sized uint32 buffer: every element takes R
// steps of the LCG x = x * 1664525 + 1013904223 (mod 2^32) per launch. The
// map never converges, so a lost or repeated launch changes every element.
// R is calibrated so that one launch takes about KERNEL_MS, unless ROUNDS
// gives it (so two workloads can do the same work per launch). The host synchronizes after every QUEUE
// launches, so at most QUEUE launches are queued on the GPU at once.
// Every 100 ms it appends {"t": unix seconds, "kernels": launches completed}
// to STATE_DIR/NAME.jsonl. At the end it recomputes 16 elements on the CPU
// with the same number of steps and writes STATE_DIR/NAME.result.json with
// whether the GPU result matches exactly.
#include <cuda_runtime.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define CHECK(call) do { cudaError_t e = (call); if (e != cudaSuccess) { \
    fprintf(stderr, "%s:%d %s\n", __FILE__, __LINE__, cudaGetErrorString(e)); exit(2); } } while (0)

__host__ __device__ static inline unsigned lcg(unsigned v) { return v * 1664525u + 1013904223u; }

__global__ void step(unsigned *x, size_t n, int rounds) {
    size_t i = blockIdx.x * (size_t)blockDim.x + threadIdx.x;
    if (i >= n) return;
    unsigned v = x[i];
    for (int r = 0; r < rounds; r++) v = lcg(v);
    x[i] = v;
}

static double now(void) {
    struct timespec t;
    clock_gettime(CLOCK_REALTIME, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}

static unsigned initial(size_t i) { return (unsigned)(i * 2654435761u); }

int main(int argc, char **argv) {
    if (argc != 7 && argc != 8) {
        fprintf(stderr, "usage: gpu_probe NAME STATE_DIR SECONDS MIB KERNEL_MS QUEUE [ROUNDS]\n");
        return 64;
    }
    const char *name = argv[1], *dir = argv[2];
    double seconds = atof(argv[3]), kernel_ms = atof(argv[5]);
    size_t n = (size_t)atol(argv[4]) * 1024 * 1024 / sizeof(unsigned);
    int queue = atoi(argv[6]);
    CHECK(cudaSetDeviceFlags(cudaDeviceScheduleBlockingSync));
    unsigned *x;
    CHECK(cudaMalloc(&x, n * sizeof(unsigned)));
    unsigned *host = (unsigned *)malloc(n * sizeof(unsigned));
    for (size_t i = 0; i < n; i++) host[i] = initial(i);
    CHECK(cudaMemcpy(x, host, n * sizeof(unsigned), cudaMemcpyHostToDevice));
    unsigned blocks = (unsigned)((n + 255) / 256);

    // Calibrate on a scratch copy so the checked buffer only sees counted launches.
    unsigned *scratch;
    CHECK(cudaMalloc(&scratch, n * sizeof(unsigned)));
    cudaEvent_t a, b;
    CHECK(cudaEventCreate(&a));
    CHECK(cudaEventCreate(&b));
    int rounds = 64;
    float ms = 0;
    for (int tries = 0; tries < 6 && argc == 7; tries++) {
        CHECK(cudaEventRecord(a));
        step<<<blocks, 256>>>(scratch, n, rounds);
        CHECK(cudaEventRecord(b));
        CHECK(cudaEventSynchronize(b));
        CHECK(cudaEventElapsedTime(&ms, a, b));
        int next = (int)(rounds * kernel_ms / (ms > 0.01f ? ms : 0.01f));
        rounds = next < 1 ? 1 : next;
    }
    if (argc == 8) {
        rounds = atoi(argv[7]);
        CHECK(cudaEventRecord(a));
        step<<<blocks, 256>>>(scratch, n, rounds);
        CHECK(cudaEventRecord(b));
        CHECK(cudaEventSynchronize(b));
        CHECK(cudaEventElapsedTime(&ms, a, b));
    }
    CHECK(cudaFree(scratch));

    char path[4096];
    snprintf(path, sizeof path, "%s/%s.jsonl", dir, name);
    FILE *log = fopen(path, "w");
    size_t free_b, total_b;
    CHECK(cudaMemGetInfo(&free_b, &total_b));
    fprintf(log, "{\"t\": %.3f, \"kernels\": 0, \"pid\": %d, \"rounds\": %d, \"calibratedMs\": %.3f, "
                 "\"bufferMiB\": %zu, \"deviceFreeMiB\": %zu, \"deviceTotalMiB\": %zu}\n",
            now(), getpid(), rounds, ms, n * sizeof(unsigned) >> 20, free_b >> 20, total_b >> 20);
    fflush(log);

    long kernels = 0;
    double start = now(), last = start;
    while (now() - start < seconds) {
        step<<<blocks, 256>>>(x, n, rounds);
        kernels++;
        if (kernels % queue == 0) CHECK(cudaStreamSynchronize(0));
        double t = now();
        if (t - last >= 0.1) {
            CHECK(cudaMemGetInfo(&free_b, &total_b));
            // Launches up to the last synchronization have certainly completed.
            fprintf(log, "{\"t\": %.3f, \"kernels\": %ld, \"deviceFreeMiB\": %zu}\n", t, kernels - kernels % queue, free_b >> 20);
            fflush(log);
            last = t;
        }
    }
    CHECK(cudaDeviceSynchronize());
    fprintf(log, "{\"t\": %.3f, \"kernels\": %ld}\n", now(), kernels);
    fclose(log);

    CHECK(cudaMemcpy(host, x, n * sizeof(unsigned), cudaMemcpyDeviceToHost));
    int mismatches = 0;
    long long steps = (long long)kernels * rounds;
    for (int s = 0; s < 16; s++) {
        size_t i = (size_t)s * (n / 16) + (size_t)s * 7;
        unsigned v = initial(i);
        for (long long r = 0; r < steps; r++) v = lcg(v);
        if (v != host[i]) mismatches++;
    }
    snprintf(path, sizeof path, "%s/%s.result.json", dir, name);
    FILE *out = fopen(path, "w");
    fprintf(out, "{\"name\": \"%s\", \"pid\": %d, \"kernels\": %ld, \"rounds\": %d, \"stepsPerElement\": %lld, "
                 "\"checked\": 16, \"mismatches\": %d, \"valid\": %s, \"finishedAt\": %.3f}\n",
            name, getpid(), kernels, rounds, steps, mismatches, mismatches ? "false" : "true", now());
    fclose(out);
    return mismatches ? 1 : 0;
}
