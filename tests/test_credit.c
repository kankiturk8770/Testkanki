/* Regression specification for durable, conservative distributed volume credit. */
#include "kanki_credit.h"
#include <assert.h>
#include <sys/wait.h>
static void fresh(char path[64]){
    strcpy(path,"/tmp/kanki-credit-XXXXXX");int fd=mkstemp(path);assert(fd>=0);
    assert(write(fd,KANKI_CREDIT_HEADER,strlen(KANKI_CREDIT_HEADER))==(ssize_t)strlen(KANKI_CREDIT_HEADER));assert(!fsync(fd));close(fd);
}
int main(void){
    char path[64];fresh(path);credit_store s={.fd=-1},second={.fd=-1};
    assert(!credit_open(&s,path));assert(credit_open(&second,path)<0); // exclusive ownership
    assert(credit_charge(&s,"alice",100,28)==1);assert(credit_reserved(&s,"alice")==100);
    assert(credit_available(&s,"alice",100)==72);assert(credit_charge(&s,"alice",100,73)==0);
    assert(credit_charge(&s,"alice",100,72)==1);assert(credit_charge(&s,"alice",100,1)==0);
    assert(credit_charge(&s,"bob",500,1)==1);assert(credit_reserved(&s,"bob")==500);
    uint64_t balance=credit_available(&s,"bob",500);
    assert(!credit_compact(&s));assert(credit_open(&second,path)<0);
    assert(credit_available(&s,"bob",500)==balance);
    credit_close(&s);assert(!credit_open(&s,path));
    assert(credit_available(&s,"alice",100)==0);assert(credit_available(&s,"bob",500)==0);
    assert(credit_charge(&s,"alice",1000,1)==1);assert(credit_reserved(&s,"alice")==1000);
    credit_close(&s);
    // Crash after fsync but before local use: reservation stays spent, never reusable.
    pid_t child=fork();assert(child>=0);
    if(!child){credit_store c={.fd=-1};assert(!credit_open(&c,path));assert(credit_charge(&c,"crash",100,1)==1);_exit(0);}
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
    assert(!credit_open(&s,path));assert(credit_available(&s,"crash",100)==0);credit_close(&s);
    // Incomplete uncommitted tail is trimmed before a new record is appended.
    int fd=open(path,O_WRONLY|O_APPEND);assert(fd>=0);assert(write(fd,"incomplete",10)==10);close(fd);
    assert(!credit_open(&s,path));assert(credit_charge(&s,"new",100,1)==1);credit_close(&s);
    assert(!credit_open(&s,path));assert(credit_reserved(&s,"new")==100);credit_close(&s);
    // Complete but corrupt records are never silently ignored.
    fd=open(path,O_WRONLY|O_APPEND);assert(fd>=0);assert(write(fd,"bad 1 invalid\n",14)==14);close(fd);
    assert(credit_open(&s,path)<0);unlink(path);
    assert(credit_open(&s,path)<0); // never recreate a missing established journal
    puts("durable credit: PASS (exclusive ledger, exact caps, independent users, crash, torn tail, corruption, missing storage)");
}
