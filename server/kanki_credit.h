/* Durable quota escrow. No protocol, cipher, FEC or packet-scheduling changes.
   The journal must be provisioned once by the node agent. A reserved block is
   fsynced BEFORE forwarding; unused bytes are burned on restart, never reused. */
#ifndef KANKI_CREDIT_H
#define KANKI_CREDIT_H
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <inttypes.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <openssl/evp.h>
#define KANKI_CREDIT_HEADER "KANKI_CREDIT_V1\n"
#define KANKI_CREDIT_BLOCK 65536u
#define KANKI_CREDIT_MAX UINT64_C(1000000000000000000)
typedef struct {char name[64];uint64_t reserved,balance;} credit_entry;
typedef struct {int fd,failed;credit_entry *entries;size_t count,capacity;char *path;} credit_store;
static int credit_name_valid(const char *name){
    size_t n=name?strlen(name):0;if(!n||n>63)return 0;
    for(size_t i=0;i<n;i++)if(!((name[i]>='a'&&name[i]<='z')||(name[i]>='A'&&name[i]<='Z')||
        (name[i]>='0'&&name[i]<='9')||name[i]=='_'||name[i]=='-'))return 0;
    return 1;
}
static credit_entry *credit_find(credit_store *s,const char *name,int create){
    size_t lo=0,hi=s->count;
    while(lo<hi){size_t mid=lo+(hi-lo)/2;int cmp=strcmp(s->entries[mid].name,name);if(cmp<0)lo=mid+1;else hi=mid;}
    if(lo<s->count&&!strcmp(s->entries[lo].name,name))return &s->entries[lo];
    if(!create||!credit_name_valid(name))return NULL;
    if(s->count==s->capacity){
        size_t cap=s->capacity?s->capacity*2:32;
        if(cap>1000000)return NULL; // refuse an unexpectedly large/corrupt journal
        credit_entry *next=realloc(s->entries,cap*sizeof *next);if(!next)return NULL;s->entries=next;s->capacity=cap;
    }
    memmove(s->entries+lo+1,s->entries+lo,(s->count-lo)*sizeof *s->entries);
    credit_entry *e=&s->entries[lo];memset(e,0,sizeof *e);snprintf(e->name,sizeof e->name,"%s",name);s->count++;return e;
}
static int credit_digest(const char *payload,char hex[65]){
    unsigned char digest[32];unsigned int n=0;
    if(EVP_Digest(payload,strlen(payload),digest,&n,EVP_sha256(),NULL)!=1||n!=32)return -1;
    for(int i=0;i<32;i++)snprintf(hex+i*2,3,"%02x",digest[i]);
    return 0;
}
static void credit_close(credit_store *s){
    if(s->fd>=0)close(s->fd);
    free(s->entries);free(s->path);memset(s,0,sizeof *s);s->fd=-1;
}
static int credit_open(credit_store *s,const char *path){
    memset(s,0,sizeof *s);s->fd=-1;
    int fd=open(path,O_RDWR|O_APPEND|O_CLOEXEC|O_NOFOLLOW);if(fd<0)return -1;s->fd=fd;
    if(flock(fd,LOCK_EX|LOCK_NB))goto bad;
    s->path=strdup(path);if(!s->path)goto bad;
    int copy=dup(fd);if(copy<0)goto bad;FILE *f=fdopen(copy,"r");if(!f){close(copy);goto bad;}
    char line[256];if(!fgets(line,sizeof line,f)||strcmp(line,KANKI_CREDIT_HEADER)){fclose(f);goto bad;}
    off_t complete=ftello(f);int valid=1;
    while(fgets(line,sizeof line,f)){
        size_t n=strlen(line);
        if(!n||line[n-1]!='\n'){
            if(feof(f)){if(ftruncate(fd,complete)||fsync(fd))valid=0;break;}
            valid=0;break;
        }
        char name[64],hash[65],extra;unsigned long long amount;
        if(sscanf(line,"%63s %llu %64s %c",name,&amount,hash,&extra)!=3||!credit_name_valid(name)||amount>KANKI_CREDIT_MAX){valid=0;break;}
        char payload[96],expected[65],canonical[180];snprintf(payload,sizeof payload,"%s %llu",name,amount);
        if(credit_digest(payload,expected)){valid=0;break;}
        snprintf(canonical,sizeof canonical,"%s %s\n",payload,expected);
        if(strcmp(canonical,line)||strcmp(hash,expected)){valid=0;break;}
        credit_entry *e=credit_find(s,name,1);if(!e||amount<e->reserved){valid=0;break;}e->reserved=amount;
        complete=ftello(f);
    }
    if(ferror(f))valid=0;
    fclose(f);if(!valid)goto bad;return 0;
 bad:credit_close(s);return -1;
}
static uint64_t credit_reserved(credit_store *s,const char *name){credit_entry *e=credit_find(s,name,0);return e?e->reserved:0;}
static uint64_t credit_available(credit_store *s,const char *name,uint64_t limit){
    if(s->failed||s->fd<0||limit>KANKI_CREDIT_MAX||!credit_name_valid(name))return 0;
    credit_entry *e=credit_find(s,name,0);if(!e)return limit;
    if(e->reserved>limit)return 0;
    return limit-e->reserved+e->balance;
}
static int credit_write(int fd,const char *data,size_t len){
    size_t done=0;
    while(done<len){ssize_t n=write(fd,data+done,len-done);if(n<0&&errno==EINTR)continue;
        if(n<=0)return -1;
        done+=(size_t)n;}
    return 0;
}
static int credit_record(int fd,const char *name,uint64_t total){
    char payload[96],hash[65],line[180];snprintf(payload,sizeof payload,"%s %" PRIu64,name,total);
    if(credit_digest(payload,hash))return -1;
    int len=snprintf(line,sizeof line,"%s %s\n",payload,hash);
    return credit_write(fd,line,(size_t)len);
}
/* Atomic checkpoint retains every historical account and both inode locks
   until rename + directory fsync. RAM balances survive; restart still burns them. */
static int credit_compact(credit_store *s){
    size_t n=strlen(s->path)+32;char *tmp=malloc(n),*parent=strdup(s->path);
    int fd=-1,dir=-1,result=-1;if(tmp)tmp[0]=0;if(!tmp||!parent)goto end;
    snprintf(tmp,n,"%s.checkpoint-XXXXXX",s->path);fd=mkstemp(tmp);if(fd<0)goto end;
    if(fcntl(fd,F_SETFD,FD_CLOEXEC)||flock(fd,LOCK_EX|LOCK_NB)||fchmod(fd,0600)||
       credit_write(fd,KANKI_CREDIT_HEADER,strlen(KANKI_CREDIT_HEADER)))goto end;
    for(size_t i=0;i<s->count;i++)if(credit_record(fd,s->entries[i].name,s->entries[i].reserved))goto end;
    char *slash=strrchr(parent,'/');if(slash){if(slash==parent)slash[1]=0;else *slash=0;}else strcpy(parent,".");
    dir=open(parent,O_RDONLY|O_DIRECTORY|O_CLOEXEC);if(dir<0||fsync(fd)||rename(tmp,s->path))goto end;
    close(s->fd);s->fd=fd;fd=-1;
    if(fsync(dir))goto end;
    result=0;
 end:
    if(fd>=0)close(fd);
    if(dir>=0)close(dir);
    if(tmp){if(result)unlink(tmp);free(tmp);}
    free(parent);if(result)s->failed=1;return result;
}
/* 1 allowed, 0 no credit, -1 fatal storage/integrity failure (fail closed). */
static int credit_charge(credit_store *s,const char *name,uint64_t limit,uint64_t bytes){
    if(s->failed||s->fd<0)return -1;
    if(!bytes||limit>KANKI_CREDIT_MAX||bytes>credit_available(s,name,limit))return 0;
    credit_entry *e=credit_find(s,name,1);if(!e){s->failed=1;return -1;}
    if(bytes>e->balance){
        uint64_t reserve=bytes-e->balance;if(reserve<KANKI_CREDIT_BLOCK)reserve=KANKI_CREDIT_BLOCK;
        if(reserve>limit-e->reserved)reserve=limit-e->reserved;
        uint64_t next=e->reserved+reserve;
        struct stat info;
        if(fstat(s->fd,&info)||((uint64_t)info.st_size> (s->count*512u>8388608u?s->count*512u:8388608u) && credit_compact(s))||
           credit_record(s->fd,name,next)||fsync(s->fd)){s->failed=1;return -1;}
        e->reserved=next;e->balance+=reserve;
    }
    e->balance-=bytes;return 1;
}
#endif
