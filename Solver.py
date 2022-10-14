import numpy as np
import itertools as it
import time
N_MAX_MOVES = 30
CORE = 8
MARGIN = CORE
SIDE = CORE+MARGIN
m = int(MARGIN/2)
#last
_p1 = [["########",
        "###**###"],
       ["##****##",
        "##****##"]]
#_p1 = [['*'*core]*2]*4 + _p1 + [['*'*core]*2]*4
p1 = np.zeros((SIDE,SIDE,SIDE))
for x in range(0,CORE):
  for i,y in enumerate(range(4,2,-1)):
      for j,z in enumerate(range(5,3,-1)):
          p1[x+m,y+m,z+m] = _p1[j][i][x]=='#'
#deux taquets
_p2 = [["########",
        "####*###"],
       ["##**#*##",
        "##*#**##"]]
p2 = np.zeros((SIDE,SIDE,SIDE))
for i,x in enumerate(range(2,4)):
  for y in range(0,CORE):
      for j,z in enumerate(range(4,2,-1)):
          p2[x+m,y+m,z+m] = _p2[i][j][y]=='#'
#un taquet
_p3 = [["########",
        "###**###"],
       ["###*#*##",
        "##****##"]]
p3 = np.zeros((SIDE,SIDE,SIDE))
for x in range(0,CORE):
  for i,y in enumerate(range(4,2,-1)):
      for j,z in enumerate(range(2,4)):
          p3[x+m,y+m,z+m] = _p3[j][i][x]=='#'
#encoche droite
_p4 = [["########",
        "####*###"],
       ["##****##",
        "##****##"]]
p4 = np.zeros((SIDE,SIDE,SIDE))
for i,x in enumerate(range(3,5)):
  for j,y in enumerate(range(5,3,-1)):
      for z in range(0,CORE):
          p4[x+m,y+m,z+m] = _p4[j][i][z]=='#'
#first
_p5 = [["###**###",
        "########"],
       ["###**###",
        "##****##"]]
p5 = np.zeros((SIDE,SIDE,SIDE))
for i,x in enumerate(range(5,3,-1)):
  for y in range(0,CORE):
      for j,z in enumerate(range(4,2,-1)):
          p5[x+m,y+m,z+m] = _p5[j][i][y]=='#'
#bizarre
_p6 = [["########",
        "###**###"],
       ["###***##",
        "####*###"]]
p6 = np.zeros((SIDE,SIDE,SIDE))
for i,x in enumerate(range(3,5)):
  for j,y in enumerate(range(2,4)):
      for z in range(0,CORE):
          p6[x+m,y+m,z+m] = _p6[j][i][z]=='#'
PIECES = [p1,p2,p3,p4,p5,p6]
NAMES = ["last",
         "deux-taquets",
         "un-taquet",
         "encoche-droite",
         "first",
         "bizarre"]
PIECES_DICT = dict(zip(NAMES,PIECES))
#test of intial collision state
assembly = sum(PIECES)
if 2 in np.ravel(assembly):
  print("Erreur de design, il y a une collision au départ")
  for p_a,p_b in it.combinations(PIECES_DICT.items(),2):
      if 2 in np.ravel(p_a[1]+p_b[1]):
          print(f'Collision de "{p_a[0]}" avec "{p_b[0]}"')
          n = list(np.ravel(p_a[1]+p_b[1])).count(2)
          print(f'\t{n} collisions')
  exit()
"""
p = []
#last
p+=[[(0,3,4),(0,4,4),(0,3,5),(0,4,5),
     (1,3,4),(1,4,4),(1,3,5),(1,4,5),
     (2,3,5),(2,4,5),
     (3,4,5),
     (4,4,5),
     (5,3,5),(5,4,5),
     (6,3,4),(6,4,4),(6,3,5),(6,4,5),
     (7,3,4),(7,4,4),(7,3,5),(7,4,5)]]
#deux taquets
p+=[[(2,0,3),(2,0,4),(3,0,3),(3,0,4),
     (2,1,3),(2,1,4),(3,1,3),(3,1,4),
     (2,2,3),(2,2,4),
     (2,3,3),(2,3,4),(3,3,3),
     (2,4,4),(3,4,4),
     (2,5,3),(2,5,4),
     (2,6,3),(2,6,4),(3,6,3),(3,6,4),
     (2,7,3),(2,7,4),(3,7,3),(3,7,4)]]
#un taquet
p+=[[(0,3,2),(0,4,2),(0,3,3),(0,4,3),
     (1,3,2),(1,4,2),(1,3,3),(1,4,3),
     (2,3,2),(2,4,2),(2,4,3),
     (3,4,2),
     (4,4,2),(4,4,3),
     (5,3,2),(5,4,2),
     (6,3,2),(6,4,2),(6,3,3),(6,4,3),
     (7,3,2),(7,4,2),(7,3,3),(7,4,3)]]
#encoche droite
p+=[[(3,4,0),(4,4,0),(3,5,0),(4,5,0),
     (3,4,1),(4,4,1),(3,5,1),(4,5,1),
     (3,5,2),(4,5,2),
     (3,5,3),(4,5,3),
     (3,5,4),
     (3,5,5),(4,5,5),
     (3,4,6),(4,4,6),(3,5,6),(4,5,6),
     (3,4,7),(4,4,7),(3,5,7),(4,5,7)]]
#first
p+=[[(4,0,3),(5,0,3),(4,0,4),(5,0,4),
     (4,1,3),(5,1,3),(4,1,4),(5,1,4),
     (5,2,3),(4,2,4),(5,2,4),
     (4,3,4),
     (4,4,4),
     (5,5,3),(4,5,4),(5,5,4),
     (4,6,3),(5,6,3),(4,6,4),(5,6,4),
     (4,7,3),(5,7,3),(4,7,4),(5,7,4)]]
#bizarre
p+=[[(3,2,0),(4,2,0),(3,3,0),(4,3,0),
     (3,2,1),(4,2,1),(3,3,1),(4,3,1),
     (3,2,2),(4,2,2),(3,3,2),(4,3,2),
     (3,2,3),(4,3,3),
     (3,2,4),
     (3,2,5),(4,2,5),(4,3,5),
     (3,2,6),(4,2,6),(3,3,6),(4,3,6),
     (3,2,7),(4,2,7),(3,3,7),(4,3,7)]]
pieces = [np.zeros((side+margin,side+margin,side+margin)) for i in range(6)]
for piece in p:
   for x,y,z in piece:
      pieces[0][x+int(margin/2)][y+int(margin/2)][z+int(margin/2)] = 1
"""
POSSIBLE_MOVES = np.array([[1,0,0],
                           [-1,0,0],
                           [0,1,0],
                           [0,-1,0],
                           [0,0,1],
                           [0,0,-1]])
def get_left_pieces(ids, n_pieces):
  return tuple(i for i in range(n_pieces) if i not in ids)
OPTIONS = sum([list(it.combinations(range(len(PIECES)), i+1)) for i in range(int(len(PIECES)/2))], [])   
filtered = []
for o in OPTIONS:
  if get_left_pieces(o, len(PIECES)) not in filtered:
    filtered.append(o)
OPTIONS = filtered
# Functions
def move_piece(pieces, move):
  return [np.roll(p, sum(move), axis=sum(j if t else 0 for j,t in enumerate(move))) for p in pieces]
def are_same_moves(m1, m2):
  if len(m1[0])!=len(m2[0]):
    return False
    if not (m1[0]==m2[0]).all():
      return False
    return (m1[1]==m2[1]).all()
def print_solution(moves):
  print("=================SOLUTION=================")
  for m in moves:
    print((tuple(NAMES[i] for i in m[0]), tuple(m[1])))
def get_possible_moves(moves, solutions, assemblies, pieces_list):
  #print("Previous moves:", moves)
  #ps_ids = [(i,p) for i,p in enumerate(pieces_list)]
  for ids in OPTIONS[::-1]:
    left_pieces = get_left_pieces(ids, len(pieces_list))
    #print(ids, left_pieces)      
    for m in POSSIBLE_MOVES:
      # inutile si les pieces qu'on cherche à bouger ont ete filtrées
      if len(moves):
        #si le prev_move est le meme à l'envers
        #soit memes pieces (ids) et move=-prevmove (assembly identique ?)
        #soit pieces complémentaires et meme move
        prev_left_pieces = get_left_pieces(moves[-1][0], len(pieces_list))
        if np.array_equal(m,-moves[-1][1]) and np.array_equal(np.array(ids),np.array(prev_left_pieces)):
          continue
        if np.array_equal(m,-moves[-1][1]) and np.array_equal(np.array(ids),moves[-1][0]):
          continue
        #moves = moves + [(ids,m)]
        moved = move_piece([pieces_list[i] for i in ids], m)
        #assembly = moved + sum(pieces_list[left_pieces])
        assembly = sum(moved) + sum(pieces_list[i] for i in left_pieces)
        if any([np.array_equal(assembly,ass) for ass in assemblies]):
          #print("Already known position.")
          continue
        if any(i>1 for i in np.ravel(assembly)): # attention, il peut y avoir des 3 ou plus
          pass
          #print("Impossible move. Is there another one?...")
        else:
          #print("Possible move !")
          #print('\t', ids, tuple(m))
          current_move = (np.array(ids),m)
          #print("Current move :",current_move)
          new_moves = moves + [current_move]
          #print(moves)
          #time.sleep(0.7)
          #if len(moves)>1:
          #    print("=> ",current_move)
          #    print("=> ",moves[-1])
          #    print("=> ",moves[-2])
          if len(moves)<2:
            pass
          elif are_same_moves(current_move, moves[-1]) and \
               are_same_moves(current_move, moves[-2]):
            new_moves = new_moves[:-4]
            already = False
            for s in solutions:
              already = all(are_same_moves(s_mv, mv) for s_mv, mv in zip(s, new_moves))
              if already:
                break
                if already:
                  print("Solution already found.", end='\r')
                else:
                  solutions.append(new_moves.copy())
                  #print_solution(new_moves)
                  print(f"Solution n°{len(solutions)}, {len(new_moves)} moves")#, end='\r')
              #time.sleep(10)
              return
              #exit()
            elif len(moves)>=N_MAX_MOVES:
              print("Too long, solution rejected", end='\r')
              return
            if not len(solutions):
              new_pieces_list = pieces_list.copy()
              for i,p_moved in zip(ids,moved):
                new_pieces_list[i] = p_moved
              get_possible_moves(new_moves.copy(), solutions, assemblies+[assembly], new_pieces_list )
def solve(pieces_list):
 positions = [np.zeros(3) for i in range(len(pieces_list))]
 print("Solving...")
 #print(pieces_list)
 solutions = []
 n_moves = 0
 get_possible_moves([], solutions, [], pieces_list)
 if solutions:
   n_moves = min(len(s) for s in solutions)
 if n_moves:
   print(f"There is {len(solutions)} solution(s) !")
   print(f"The minimum is {n_moves} moves")
   best = min(solutions, key=len)
   print_solution(best)
 else:
   print("There is no solution. Sorry...")
 return n_moves
# Main program
if __name__=="__main__":
 solve(PIECES)

