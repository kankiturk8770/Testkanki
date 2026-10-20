cmake_minimum_required(VERSION 3.22)
project(kanki C)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# OpenSSL for Android: build once with https://github.com/openssl/openssl
# (./Configure android-arm64) and point OPENSSL_ROOT at the install prefix,
# or use a prefab AAR. Then:
#   gradle -POPENSSL_ROOT=/path/to/openssl-android assembleDebug
set(OPENSSL_ROOT "" CACHE PATH "OpenSSL Android install prefix")

add_library(kanki SHARED kanki_jni.c)
target_compile_options(kanki PRIVATE -O2 -Wall)

if(OPENSSL_ROOT)
    target_include_directories(kanki PRIVATE ${OPENSSL_ROOT}/include)
    # static libcrypto (build-openssl.sh) -> nothing extra to package in the APK
    target_link_libraries(kanki ${OPENSSL_ROOT}/lib/libcrypto.a log)
else()
    message(FATAL_ERROR "Build OpenSSL for the Android ABI and pass -POPENSSL_ROOT=...")
endif()
